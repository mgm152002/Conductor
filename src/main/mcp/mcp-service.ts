import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { MCP_MAX_HEALTH_CHECK_INTERVAL_MS, type McpInstallResult, type McpOAuthChallenge, type McpServer } from '@shared/mcp';
import { deriveInstallFromDetail, detectSecretSlots, type McpMarketplaceEntry } from '@shared/mcp-marketplace';

/** Servers are spawned without a shell, so a leading ~/ must be made absolute. */
function expandHome(endpoint: string): string {
  return endpoint.replace(/(^|[\s'"])~\//g, (_match, prefix: string) => `${prefix}${homedir()}/`);
}
import type { CodexMcpServer } from '../adapters/objective-cli-adapter';
import type { McpRegistry } from './mcp-registry';
import type { McpOAuthToken } from './mcp-oauth';
import { parseEndpoint, type SdkMcpTransport } from './sdk-transport';

// User-facing MCP operations on top of the registry:
//  add → registered untrusted + disabled (nothing is launched or contacted);
//  approve → trusted + enabled, then connect once to list the server's tools;
//  health checks every 60 s for enabled servers;
//  approved servers can be handed to Codex for agent runs.

/** The live marketplace source (mcpservers.org in production). */
export interface MarketplaceCatalog {
  search(query: string): Promise<McpMarketplaceEntry[]>;
  detail(entry: McpMarketplaceEntry): Promise<{ codeBlocks: string[] }>;
}

/** Keychain-backed credential storage (values never leave the main process). */
export interface McpSecrets {
  put(input: { label: string; value: string; owner: string }): Promise<{ id: string }>;
  delete(id: string): Promise<void>;
  resolve(id: string): Promise<string | undefined>;
}

export interface McpOAuthFlow {
  supports(endpoint: string): boolean;
  start(server: { id: string; name: string; endpoint: string }): Promise<McpOAuthChallenge>;
  complete(serverId: string): Promise<McpOAuthToken>;
  refresh?(endpoint: string, token: McpOAuthToken): Promise<McpOAuthToken>;
  cancel(serverId: string): void;
}

/** A server record with credential placeholders substituted (main-only). */
export type EffectiveMcpServer = McpServer & { resolvedEnv?: Record<string, string>; bearerToken?: string };

export class McpService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly registry: McpRegistry,
    private readonly transport: SdkMcpTransport,
    private readonly catalog?: MarketplaceCatalog,
    private readonly secrets?: McpSecrets,
    private readonly oauth?: McpOAuthFlow,
  ) {
    if (this.secrets !== undefined) {
      this.transport.setServerResolver((server) => this.resolveEffective(server));
    }
    if (this.oauth !== undefined) {
      for (const server of this.registry.list()) {
        if (this.oauth.supports(server.endpoint)) this.registry.ensureOAuthSlot(server.id);
      }
    }
  }

  /** Store a credential value in the Keychain for one of the server's slots. */
  async setSecret(serverId: string, name: string, value: string): Promise<McpServer> {
    if (this.secrets === undefined) throw new Error('Credential storage is not available.');
    const clean = value.trim();
    if (clean === '') throw new Error('Enter the API key value.');
    const server = this.registry.getOrThrow(serverId);
    const slots = this.registry.secretSlotsRaw(serverId);
    const slot = slots.find((s) => s.name === name);
    if (slot === undefined) throw new Error(`${server.name} does not need a credential named ${name}.`);
    const stored = await this.secrets.put({ label: `${server.name} ${name}`, value: clean, owner: `mcp:${serverId}` });
    if (slot.secretId !== undefined) await this.secrets.delete(slot.secretId).catch(() => undefined);
    return this.registry.setSecretRef(serverId, name, stored.id);
  }

  /** Remove a saved credential value from the Keychain. */
  async clearSecret(serverId: string, name: string): Promise<McpServer> {
    if (this.secrets === undefined) throw new Error('Credential storage is not available.');
    const slot = this.registry.secretSlotsRaw(serverId).find((s) => s.name === name);
    if (slot?.secretId !== undefined && slot?.secretId !== '') await this.secrets.delete(slot.secretId).catch(() => undefined);
    return this.registry.setSecretRef(serverId, name, undefined);
  }

  /** Store an OAuth access token in Keychain and retain only its opaque id. */
  async setOAuthToken(serverId: string, token: string): Promise<McpServer> {
    return this.setOAuthCredential(serverId, { accessToken: token, tokenType: 'bearer' });
  }

  private async setOAuthCredential(serverId: string, credential: McpOAuthToken): Promise<McpServer> {
    if (this.secrets === undefined) throw new Error('Credential storage is not available.');
    const server = this.registry.getOrThrow(serverId);
    const slot = this.registry.secretSlotsRaw(serverId).find((candidate) => candidate.kind === 'oauth');
    if (slot === undefined) throw new Error(`${server.name} is not configured for OAuth.`);
    const stored = await this.secrets.put({ label: `${server.name} OAuth`, value: JSON.stringify({ version: 1, ...credential }), owner: `mcp:${serverId}` });
    let updated: McpServer;
    try { updated = this.registry.setOAuthSecretRef(serverId, stored.id); }
    catch (error) {
      await this.secrets.delete(stored.id).catch(() => undefined);
      throw error;
    }
    if (slot.secretId !== undefined) await this.secrets.delete(slot.secretId).catch(() => undefined);
    return updated;
  }

  async clearOAuthToken(serverId: string): Promise<McpServer> {
    if (this.secrets === undefined) throw new Error('Credential storage is not available.');
    const slot = this.registry.secretSlotsRaw(serverId).find((candidate) => candidate.kind === 'oauth');
    if (slot === undefined) return this.registry.getOrThrow(serverId);
    const updated = this.registry.setOAuthSecretRef(serverId, undefined);
    if (slot.secretId !== undefined) await this.secrets.delete(slot.secretId).catch(() => undefined);
    return updated;
  }

  /**
   * Substitute saved credentials into a server record, in the main process
   * only: placeholder slots replace the literal placeholder in the endpoint
   * (e.g. YOUR_API_KEY_HERE in a header), env slots become resolvedEnv for
   * the spawned process. Unset slots are left untouched.
   */
  async resolveEffective(server: McpServer): Promise<EffectiveMcpServer> {
    if (this.secrets === undefined) return server;
    let endpoint = server.endpoint;
    const resolvedEnv: Record<string, string> = {};
    let bearerToken: string | undefined;
    for (const slot of this.registry.secretSlotsRaw(server.id)) {
      if (slot.secretId === undefined) continue;
      const value = await this.secrets.resolve(slot.secretId).catch(() => undefined);
      if (value === undefined || value === '') continue;
      if (slot.kind === 'oauth') {
        let credential: McpOAuthToken = { accessToken: value, tokenType: 'bearer' };
        try {
          const parsed = JSON.parse(value) as Partial<McpOAuthToken>;
          if (typeof parsed.accessToken === 'string') credential = { ...parsed, accessToken: parsed.accessToken, tokenType: typeof parsed.tokenType === 'string' ? parsed.tokenType : 'bearer' };
        } catch { /* legacy raw bearer token */ }
        if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now() + 30_000) {
          if (this.oauth?.refresh === undefined || credential.refreshToken === undefined) {
            await this.clearOAuthToken(server.id);
            throw new Error(`${server.name} sign-in expired. Sign in again.`);
          }
          try {
            credential = await this.oauth.refresh(server.endpoint, credential);
            await this.setOAuthCredential(server.id, credential);
          } catch (error) {
            await this.clearOAuthToken(server.id);
            throw error;
          }
        }
        bearerToken = credential.accessToken;
      }
      else if (slot.placeholder !== undefined) endpoint = endpoint.split(slot.placeholder).join(value);
      else resolvedEnv[slot.name] = value;
    }
    return { ...server, endpoint, ...(Object.keys(resolvedEnv).length > 0 ? { resolvedEnv } : {}), ...(bearerToken !== undefined ? { bearerToken } : {}) };
  }

  list(): McpServer[] {
    return this.registry.list();
  }

  discover() {
    return this.registry.discover();
  }

  add(input: { name: string; endpoint: string }): McpServer {
    const endpoint = expandHome(input.endpoint);
    parseEndpoint(endpoint); // validate before persisting
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server';
    const oauth = this.oauth?.supports(endpoint) === true
      ? [{ name: '__oauth_bearer', kind: 'oauth' as const }]
      : [];
    return this.registry.register({ id: `${slug}-${randomUUID().slice(0, 8)}`, name: input.name, endpoint, secretSlots: [...detectSecretSlots(endpoint), ...oauth] });
  }

  private marketplaceCache = new Map<string, McpMarketplaceEntry>();
  private marketplaceCachedAt = 0;

  /**
   * The mcpservers.org catalog, browsed live. Cached for five minutes;
   * throws when the site is unreachable so the UI can say so.
   */
  async marketplace(search?: string): Promise<readonly McpMarketplaceEntry[]> {
    if (this.catalog === undefined) throw new Error('The MCP marketplace is not available.');
    const query = (search ?? '').trim();
    if (query === '' && Date.now() - this.marketplaceCachedAt < 5 * 60_000 && this.marketplaceCache.size > 0) {
      return [...this.marketplaceCache.values()];
    }
    const entries = await this.catalog.search(query);
    for (const entry of entries) this.marketplaceCache.set(entry.id, entry);
    if (query === '') this.marketplaceCachedAt = Date.now();
    return entries;
  }

  /**
   * One-click install from mcpservers.org: reads the server's detail page,
   * derives its published install configuration, and registers it
   * untrusted + stopped, exactly like adding it by hand. Installing the
   * same entry twice returns the existing registration.
   */
  async installMarketplace(entryId: string): Promise<McpServer> {
    if (this.catalog === undefined) throw new Error('The MCP marketplace is not available.');
    let entry = this.marketplaceCache.get(entryId);
    if (entry === undefined) {
      const segment = entryId.split('/').pop() ?? entryId;
      const found = await this.marketplace(segment);
      entry = found.find((candidate) => candidate.id === entryId) ?? this.marketplaceCache.get(entryId);
    }
    if (entry === undefined) throw new Error(`MCP server ${entryId} was not found on mcpservers.org — search for it in the marketplace first`);
    const detail = await this.catalog.detail(entry);
    const derived = deriveInstallFromDetail(detail.codeBlocks);
    if (!derived.installable) throw new Error(derived.note);
    const endpoint = expandHome(derived.endpoint);
    const slug = entry.id.split('/').pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server';
    const existing = this.registry.list().find((server) => server.id.startsWith(`${slug}-`) && server.endpoint === endpoint);
    if (existing !== undefined) return this.oauth?.supports(existing.endpoint) === true
      ? this.registry.ensureOAuthSlot(existing.id)
      : existing;
    parseEndpoint(endpoint);
    const oauth = this.oauth?.supports(endpoint) === true
      ? [{ name: '__oauth_bearer', kind: 'oauth' as const }]
      : [];
    return this.registry.register({ id: `${slug}-${randomUUID().slice(0, 8)}`, name: entry.name, endpoint, secretSlots: [...derived.secretSlots, ...oauth] });
  }

  /** Install and immediately launch OAuth when the endpoint supports it. */
  async installAndAuthorize(entryId: string): Promise<McpInstallResult> {
    const server = await this.installMarketplace(entryId);
    if (server.authentication?.type !== 'oauth' || server.authentication.status === 'connected') return { server };
    return { server, oauth: await this.startOAuth(server.id) };
  }

  async startOAuth(serverId: string): Promise<McpOAuthChallenge> {
    if (this.oauth === undefined) throw new Error('OAuth is not available in this Conductor build.');
    const server = this.registry.getOrThrow(serverId);
    return this.oauth.start(server);
  }

  /** Finish OAuth, save the token, then approve, enable, and load tools. */
  async completeOAuth(serverId: string): Promise<McpServer> {
    if (this.oauth === undefined) throw new Error('OAuth is not available in this Conductor build.');
    const token = await this.oauth.complete(serverId);
    await this.setOAuthCredential(serverId, token);
    try { return await this.approve(serverId); }
    catch (error) {
      await this.clearOAuthToken(serverId);
      throw error;
    }
  }

  cancelOAuth(serverId: string): void {
    this.oauth?.cancel(serverId);
  }

  /** Approve, enable and list tools. Rolls back to disabled if the server cannot be reached. */
  async approve(id: string): Promise<McpServer> {
    this.registry.approve(id, 'user');
    const enabled = this.registry.enable(id);
    try {
      const tools = await this.transport.listTools(enabled);
      this.registry.setCapabilities(id, tools);
      return await this.registry.checkHealth(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // OAuth remote servers (Higgsfield, Linear, Notion, …) refuse an
      // unauthenticated tool list — the agent CLIs run the vendor's OAuth
      // sign-in themselves when they connect. That is not a dead server:
      // stay enabled (agents can still be offered it) with tools unknown
      // until an agent connects.
      if (enabled.authentication?.status !== 'connected' && parseEndpoint(enabled.endpoint).kind === 'http' && /401|403|unauthor|forbidden|authori[sz]ation header|authentication required/i.test(message)) {
        await this.transport.disconnect(id);
        return this.registry.getOrThrow(id);
      }
      await this.transport.disconnect(id);
      this.registry.disable(id);
      throw new Error(`Could not start or reach the MCP server: ${message}`);
    }
  }

  async disable(id: string): Promise<McpServer> {
    await this.transport.disconnect(id);
    return this.registry.disable(id);
  }

  async remove(id: string): Promise<void> {
    await this.transport.disconnect(id);
    if (this.secrets !== undefined) {
      const ids = this.registry.secretSlotsRaw(id).map((slot) => slot.secretId).filter((secretId): secretId is string => secretId !== undefined);
      await Promise.all(ids.map((secretId) => this.secrets!.delete(secretId).catch(() => undefined)));
    }
    this.registry.remove(id);
  }

  checkHealth(id: string): Promise<McpServer> {
    return this.registry.checkHealth(id);
  }

  invoke(input: { id: string; tool: string; args?: Record<string, unknown> }) {
    return this.registry.invoke({ serverId: input.id, capabilityId: input.tool, args: input.args ?? {}, caller: 'user' });
  }

  startHealthChecks(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.registry.runHealthChecks().catch(() => undefined); }, MCP_MAX_HEALTH_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.transport.closeAll();
  }

  /** Approved, enabled servers (credentials substituted) for every agent CLI. */
  async forAgents(): Promise<CodexMcpServer[]> {
    const out: CodexMcpServer[] = [];
    for (const server of this.registry.list()) {
      if (server.trustStatus !== 'trusted' || server.enablement !== 'enabled') continue;
      if (server.authentication?.status === 'sign_in_required') continue;
      try {
        const effective = await this.resolveEffective(server);
        const endpoint = parseEndpoint(effective.endpoint);
        // A stdio server Conductor itself probed unhealthy is broken;
        // leave it out. A remote server's health from here only proves
        // it wants OAuth sign-in, which the agent performs — offer it.
        if (endpoint.kind === 'stdio' && server.health === 'unhealthy') continue;
        const key = server.id.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
        const tools = server.capabilities.map((c) => c.id).slice(0, 12);
        out.push(endpoint.kind === 'http'
          ? { key, url: endpoint.url!.toString(), ...(effective.bearerToken !== undefined ? { headers: { Authorization: `Bearer ${effective.bearerToken}` } } : {}), ...(tools.length > 0 ? { tools } : {}) }
          : { key, command: endpoint.command!, args: endpoint.args ?? [], ...(effective.resolvedEnv !== undefined ? { env: effective.resolvedEnv } : {}), ...(tools.length > 0 ? { tools } : {}) });
      } catch { /* skip unparseable */ }
    }
    return out;
  }
}
