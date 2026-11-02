import type { McpOAuthChallenge } from '@shared/mcp';

export type McpOAuthErrorReason = 'unsupported' | 'not_configured' | 'denied' | 'expired' | 'network' | 'not_started' | 'cancelled';

export class McpOAuthError extends Error {
  constructor(readonly reason: McpOAuthErrorReason, message: string) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

export interface McpOAuthToken {
  accessToken: string;
  tokenType: string;
  scope?: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface OAuthServerRef { id: string; name: string; endpoint: string }
interface PendingAuthorization { deviceCode: string; expiresAt: number; intervalMs: number; cancelled: boolean }

/** Provider adapter. Additional OAuth vendors plug in here without changing IPC/UI. */
export interface McpOAuthProvider {
  readonly name: string;
  supports(endpoint: string): boolean;
  start(server: OAuthServerRef): Promise<McpOAuthChallenge>;
  complete(serverId: string): Promise<McpOAuthToken>;
  refresh?(token: McpOAuthToken): Promise<McpOAuthToken>;
  cancel(serverId: string): void;
}

export interface DeviceOAuthProviderOptions {
  name: string;
  endpointPrefixes: readonly string[];
  clientId: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  scopes?: readonly string[];
  fetchFn?: typeof fetch;
  openExternal: (url: string) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Configuration-driven RFC 8628 device-flow provider adapter. */
export class DeviceOAuthProvider implements McpOAuthProvider {
  readonly name: string;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DeviceOAuthProviderOptions) {
    this.name = options.name;
    for (const endpoint of [options.deviceAuthorizationEndpoint, options.tokenEndpoint]) {
      if (new URL(endpoint).protocol !== 'https:') throw new Error(`${options.name} OAuth endpoints must use HTTPS.`);
    }
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  supports(endpoint: string): boolean {
    try {
      const url = new URL(endpoint);
      return url.protocol === 'https:' && this.options.endpointPrefixes.some((prefix) => {
        const expected = new URL(prefix);
        return url.origin === expected.origin && url.pathname.startsWith(expected.pathname);
      });
    } catch { return false; }
  }

  async start(server: OAuthServerRef): Promise<McpOAuthChallenge> {
    if (!this.supports(server.endpoint)) throw new McpOAuthError('unsupported', `${server.name} is not supported by the ${this.name} OAuth provider.`);
    const clientId = this.options.clientId.trim();
    if (clientId === '') throw new McpOAuthError('not_configured', `${this.name} OAuth is not configured in this Conductor build.`);

    const body = new URLSearchParams({ client_id: clientId });
    if ((this.options.scopes ?? []).length > 0) body.set('scope', this.options.scopes!.join(' '));
    let response: Response;
    try {
      response = await this.fetchFn(this.options.deviceAuthorizationEndpoint, { method: 'POST', headers: { accept: 'application/json' }, body });
    } catch {
      throw new McpOAuthError('network', `Could not reach ${this.name} to start sign-in.`);
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const deviceCode = typeof payload?.['device_code'] === 'string' ? payload['device_code'] : undefined;
    const userCode = typeof payload?.['user_code'] === 'string' ? payload['user_code'] : undefined;
    const verificationUrl = typeof payload?.['verification_uri'] === 'string' ? payload['verification_uri'] : undefined;
    const expiresIn = typeof payload?.['expires_in'] === 'number' ? payload['expires_in'] : 900;
    const interval = typeof payload?.['interval'] === 'number' ? payload['interval'] : 5;
    let safeVerificationUrl = false;
    try { safeVerificationUrl = verificationUrl !== undefined && new URL(verificationUrl).protocol === 'https:'; } catch { /* invalid provider response */ }
    if (!response.ok || deviceCode === undefined || userCode === undefined || verificationUrl === undefined || !safeVerificationUrl) {
      throw new McpOAuthError('network', `${this.name} did not return a valid sign-in challenge.`);
    }
    this.cancel(server.id);
    const expiresAt = this.now() + expiresIn * 1_000;
    this.pending.set(server.id, { deviceCode, expiresAt, intervalMs: interval * 1_000, cancelled: false });
    try { await this.options.openExternal(verificationUrl); }
    catch {
      this.pending.delete(server.id);
      throw new McpOAuthError('network', `Could not open ${this.name} sign-in.`);
    }
    return { serverId: server.id, providerName: this.name, verificationUrl, userCode, expiresAt };
  }

  async complete(serverId: string): Promise<McpOAuthToken> {
    const authorization = this.pending.get(serverId);
    if (authorization === undefined) throw new McpOAuthError('not_started', `Start ${this.name} sign-in first.`);
    let intervalMs = authorization.intervalMs;
    while (!authorization.cancelled && this.now() < authorization.expiresAt) {
      await this.sleep(intervalMs);
      if (authorization.cancelled) break;
      const body = new URLSearchParams({
        client_id: this.options.clientId.trim(), device_code: authorization.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      let response: Response;
      try {
        response = await this.fetchFn(this.options.tokenEndpoint, { method: 'POST', headers: { accept: 'application/json' }, body });
      } catch {
        this.clearPending(serverId, authorization);
        throw new McpOAuthError('network', `Could not reach ${this.name} to finish sign-in.`);
      }
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      const accessToken = typeof payload?.['access_token'] === 'string' ? payload['access_token'] : undefined;
      if (response.ok && accessToken !== undefined) {
        this.clearPending(serverId, authorization);
        return {
          accessToken,
          tokenType: typeof payload?.['token_type'] === 'string' ? payload['token_type'] : 'bearer',
          ...(typeof payload?.['scope'] === 'string' ? { scope: payload['scope'] } : {}),
          ...(typeof payload?.['refresh_token'] === 'string' ? { refreshToken: payload['refresh_token'] } : {}),
          ...(typeof payload?.['expires_in'] === 'number' ? { expiresAt: this.now() + payload['expires_in'] * 1_000 } : {}),
        };
      }
      const error = typeof payload?.['error'] === 'string' ? payload['error'] : '';
      if (error === 'authorization_pending') continue;
      if (error === 'slow_down') { intervalMs += 5_000; continue; }
      this.clearPending(serverId, authorization);
      if (error === 'access_denied') throw new McpOAuthError('denied', `${this.name} sign-in was denied.`);
      if (error === 'expired_token') throw new McpOAuthError('expired', `The ${this.name} sign-in code expired.`);
      throw new McpOAuthError('network', `${this.name} could not complete sign-in.`);
    }
    this.clearPending(serverId, authorization);
    if (authorization.cancelled) throw new McpOAuthError('cancelled', `${this.name} sign-in was cancelled.`);
    throw new McpOAuthError('expired', `The ${this.name} sign-in code expired.`);
  }

  cancel(serverId: string): void {
    const authorization = this.pending.get(serverId);
    if (authorization !== undefined) authorization.cancelled = true;
    this.pending.delete(serverId);
  }

  async refresh(token: McpOAuthToken): Promise<McpOAuthToken> {
    if (token.refreshToken === undefined) throw new McpOAuthError('expired', `${this.name} sign-in expired. Sign in again.`);
    const body = new URLSearchParams({
      client_id: this.options.clientId.trim(), grant_type: 'refresh_token', refresh_token: token.refreshToken,
    });
    let response: Response;
    try { response = await this.fetchFn(this.options.tokenEndpoint, { method: 'POST', headers: { accept: 'application/json' }, body }); }
    catch { throw new McpOAuthError('network', `Could not reach ${this.name} to refresh sign-in.`); }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const accessToken = typeof payload?.['access_token'] === 'string' ? payload['access_token'] : undefined;
    if (!response.ok || accessToken === undefined) throw new McpOAuthError('expired', `${this.name} sign-in expired. Sign in again.`);
    return {
      accessToken,
      tokenType: typeof payload?.['token_type'] === 'string' ? payload['token_type'] : token.tokenType,
      ...(typeof payload?.['scope'] === 'string' ? { scope: payload['scope'] } : token.scope !== undefined ? { scope: token.scope } : {}),
      refreshToken: typeof payload?.['refresh_token'] === 'string' ? payload['refresh_token'] : token.refreshToken,
      ...(typeof payload?.['expires_in'] === 'number' ? { expiresAt: this.now() + payload['expires_in'] * 1_000 } : {}),
    };
  }

  private clearPending(serverId: string, authorization: PendingAuthorization): void {
    if (this.pending.get(serverId) === authorization) this.pending.delete(serverId);
  }
}

export type GitHubDeviceOAuthOptions = Omit<DeviceOAuthProviderOptions,
  'name' | 'endpointPrefixes' | 'deviceAuthorizationEndpoint' | 'tokenEndpoint' | 'scopes'>;

/** Built-in provider; other vendors use DeviceOAuthProvider configuration. */
export class GitHubDeviceOAuthProvider extends DeviceOAuthProvider {
  constructor(options: GitHubDeviceOAuthOptions) {
    super({
      ...options,
      name: 'GitHub',
      endpointPrefixes: ['https://api.githubcopilot.com/mcp/'],
      deviceAuthorizationEndpoint: 'https://github.com/login/device/code',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:org', 'read:user'],
    });
  }
}

/** Parse additional device-flow providers supplied by a packaged build. */
export function configuredDeviceOAuthProviders(
  raw: string | undefined,
  dependencies: Pick<DeviceOAuthProviderOptions, 'openExternal'>,
): DeviceOAuthProvider[] {
  if (raw === undefined || raw.trim() === '') return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('CONDUCTOR_MCP_OAUTH_PROVIDERS must be valid JSON.'); }
  if (!Array.isArray(value)) throw new Error('CONDUCTOR_MCP_OAUTH_PROVIDERS must be a JSON array.');
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`OAuth provider ${index} must be an object.`);
    const entry = item as Record<string, unknown>;
    const text = (key: string): string => {
      const candidate = entry[key];
      if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error(`OAuth provider ${index} requires ${key}.`);
      return candidate;
    };
    const strings = (key: string): string[] => {
      const candidate = entry[key];
      if (!Array.isArray(candidate) || !candidate.every((part) => typeof part === 'string' && part.trim() !== '')) throw new Error(`OAuth provider ${index} requires string array ${key}.`);
      return candidate as string[];
    };
    return new DeviceOAuthProvider({
      ...dependencies,
      name: text('name'),
      clientId: text('clientId'),
      endpointPrefixes: strings('endpointPrefixes'),
      deviceAuthorizationEndpoint: text('deviceAuthorizationEndpoint'),
      tokenEndpoint: text('tokenEndpoint'),
      ...(entry['scopes'] !== undefined ? { scopes: strings('scopes') } : {}),
    });
  });
}

/** Routes an MCP server to a provider adapter and owns no vendor-specific logic. */
export class McpOAuthService {
  private readonly active = new Map<string, { provider: McpOAuthProvider }>();

  constructor(private readonly providers: readonly McpOAuthProvider[]) {}

  supports(endpoint: string): boolean {
    return this.providers.some((provider) => provider.supports(endpoint));
  }

  async start(server: OAuthServerRef): Promise<McpOAuthChallenge> {
    const provider = this.providers.find((candidate) => candidate.supports(server.endpoint));
    if (provider === undefined) throw new McpOAuthError('unsupported', `${server.name} does not have an OAuth provider configured in Conductor yet.`);
    this.cancel(server.id);
    const challenge = await provider.start(server);
    this.active.set(server.id, { provider });
    return challenge;
  }

  async complete(serverId: string): Promise<McpOAuthToken> {
    const active = this.active.get(serverId);
    if (active === undefined) throw new McpOAuthError('not_started', 'Start sign-in first.');
    try { return await active.provider.complete(serverId); }
    finally { if (this.active.get(serverId) === active) this.active.delete(serverId); }
  }

  cancel(serverId: string): void {
    this.active.get(serverId)?.provider.cancel(serverId);
    this.active.delete(serverId);
  }

  async refresh(endpoint: string, token: McpOAuthToken): Promise<McpOAuthToken> {
    const provider = this.providers.find((candidate) => candidate.supports(endpoint));
    if (provider?.refresh === undefined) throw new McpOAuthError('expired', 'Sign-in expired. Sign in again.');
    return provider.refresh(token);
  }
}
