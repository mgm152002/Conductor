import { describe, expect, it, vi } from 'vitest';
import { configuredDeviceOAuthProviders, GitHubDeviceOAuthProvider, McpOAuthError, McpOAuthService } from '@main/mcp/mcp-oauth';

const server = { id: 'github-1', name: 'GitHub MCP', endpoint: 'https://api.githubcopilot.com/mcp/' };

function oauth(options: ConstructorParameters<typeof GitHubDeviceOAuthProvider>[0]): McpOAuthService {
  return new McpOAuthService([new GitHubDeviceOAuthProvider(options)]);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('MCP GitHub OAuth device flow', () => {
  it('loads additional OAuth providers from build configuration', () => {
    const [provider] = configuredDeviceOAuthProviders(JSON.stringify([{
      name: 'Acme', clientId: 'public-acme-client', endpointPrefixes: ['https://mcp.acme.test/'],
      deviceAuthorizationEndpoint: 'https://auth.acme.test/device', tokenEndpoint: 'https://auth.acme.test/token', scopes: ['tools:read'],
    }]), { openExternal: async () => undefined });

    expect(provider?.name).toBe('Acme');
    expect(provider?.supports('https://mcp.acme.test/v1')).toBe(true);
    expect(provider?.supports('https://mcp.acme.test.evil.example/v1')).toBe(false);
  });

  it('routes non-GitHub servers through provider adapters without changing the coordinator', async () => {
    const provider = {
      name: 'Acme',
      supports: (endpoint: string) => endpoint === 'https://mcp.acme.test/',
      start: async (target: typeof server) => ({ serverId: target.id, providerName: 'Acme', verificationUrl: 'https://acme.test/device', userCode: 'ACME-CODE', expiresAt: 20_000 }),
      complete: async () => ({ accessToken: 'acme-token', tokenType: 'bearer' }),
      cancel: vi.fn(),
    };
    const service = new McpOAuthService([provider]);
    const target = { ...server, id: 'acme-1', endpoint: 'https://mcp.acme.test/' };

    await expect(service.start(target)).resolves.toMatchObject({ providerName: 'Acme', userCode: 'ACME-CODE' });
    await expect(service.complete(target.id)).resolves.toMatchObject({ accessToken: 'acme-token' });
  });

  it('starts authorization, opens GitHub, and returns only the redacted challenge', async () => {
    const openExternal = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => response({
      device_code: 'private-device-code', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
    }));
    const service = oauth({ clientId: 'public-client-id', fetchFn, openExternal, now: () => 1_000 });

    const challenge = await service.start(server);

    expect(challenge).toEqual({ serverId: 'github-1', providerName: 'GitHub', verificationUrl: 'https://github.com/login/device', userCode: 'ABCD-EFGH', expiresAt: 901_000 });
    expect(JSON.stringify(challenge)).not.toContain('private-device-code');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device');
  });

  it('polls pending authorization and returns a token after approval', async () => {
    const replies = [
      response({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }),
      response({ error: 'authorization_pending' }, 400),
      response({ access_token: 'gho_secret', token_type: 'bearer', scope: 'repo read:user' }),
    ];
    const sleep = vi.fn(async () => undefined);
    const service = oauth({ clientId: 'client', fetchFn: vi.fn(async () => replies.shift()!), openExternal: async () => undefined, sleep });
    await service.start(server);

    await expect(service.complete(server.id)).resolves.toEqual({ accessToken: 'gho_secret', tokenType: 'bearer', scope: 'repo read:user' });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('refreshes an expiring token and retains a rotated refresh token', async () => {
    const provider = new GitHubDeviceOAuthProvider({
      clientId: 'client', openExternal: async () => undefined, now: () => 10_000,
      fetchFn: vi.fn(async () => response({ access_token: 'fresh', token_type: 'bearer', refresh_token: 'refresh-2', expires_in: 3600 })),
    });

    await expect(provider.refresh({ accessToken: 'old', tokenType: 'bearer', refreshToken: 'refresh-1', expiresAt: 9_000 }))
      .resolves.toEqual({ accessToken: 'fresh', tokenType: 'bearer', refreshToken: 'refresh-2', expiresAt: 3_610_000 });
  });

  it('adds five seconds after GitHub asks the client to slow down', async () => {
    const replies = [
      response({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }),
      response({ error: 'slow_down' }, 400),
      response({ access_token: 'token', token_type: 'bearer' }),
    ];
    const sleep = vi.fn(async () => undefined);
    const service = oauth({ clientId: 'client', fetchFn: vi.fn(async () => replies.shift()!), openExternal: async () => undefined, sleep });
    await service.start(server);

    await service.complete(server.id);
    expect(sleep).toHaveBeenCalledWith(6_000);
  });

  it('stops polling when the user cancels the browser flow', async () => {
    let release!: () => void;
    const sleeping = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = vi.fn(async () => response({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }));
    const service = oauth({ clientId: 'client', fetchFn, openExternal: async () => undefined, sleep: async () => sleeping });
    await service.start(server);
    const completion = service.complete(server.id);

    service.cancel(server.id);
    release();

    await expect(completion).rejects.toMatchObject({ reason: 'cancelled' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not let a cancelled completion delete an immediate retry', async () => {
    const replies = [
      response({ device_code: 'old', user_code: 'OLD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }),
      response({ device_code: 'new', user_code: 'NEW', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }),
      response({ access_token: 'new-token', token_type: 'bearer' }),
    ];
    const sleepers: Array<() => void> = [];
    const service = oauth({
      clientId: 'client', fetchFn: vi.fn(async () => replies.shift()!), openExternal: async () => undefined,
      sleep: async () => new Promise<void>((resolve) => { sleepers.push(resolve); }),
    });
    await service.start(server);
    const oldCompletion = service.complete(server.id);
    service.cancel(server.id);
    await service.start(server);
    const newCompletion = service.complete(server.id);

    sleepers[0]!();
    await expect(oldCompletion).rejects.toMatchObject({ reason: 'cancelled' });
    sleepers[1]!();
    await expect(newCompletion).resolves.toMatchObject({ accessToken: 'new-token' });
  });

  it.each([
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ] as const)('reports %s as %s without exposing provider payloads', async (providerError, reason) => {
    const replies = [
      response({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }),
      response({ error: providerError, error_description: 'provider detail' }, 400),
    ];
    const service = oauth({ clientId: 'client', fetchFn: vi.fn(async () => replies.shift()!), openExternal: async () => undefined, sleep: async () => undefined });
    await service.start(server);

    await expect(service.complete(server.id)).rejects.toMatchObject({ name: 'McpOAuthError', reason });
  });

  it('rejects unsupported endpoints and missing client configuration actionably', async () => {
    const service = oauth({ clientId: '', fetchFn: vi.fn(), openExternal: async () => undefined });
    await expect(service.start(server)).rejects.toMatchObject({ reason: 'not_configured' } satisfies Partial<McpOAuthError>);
    await expect(service.start(server)).rejects.toThrow(/own OAuth App client ID/);
    await expect(service.start({ ...server, endpoint: 'https://mcp.example.com/' })).rejects.toMatchObject({ reason: 'unsupported' } satisfies Partial<McpOAuthError>);
  });

  it('reads the client ID from a getter on every sign-in, so a saved setting applies without restart', async () => {
    let id = '';
    const fetchFn = vi.fn(async () => response({ device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }));
    const service = oauth({ clientId: () => id, fetchFn, openExternal: async () => undefined });
    await expect(service.start(server)).rejects.toMatchObject({ reason: 'not_configured' });
    id = 'Ov23liUserOwnApp';
    await service.start(server);
    const body = (fetchFn.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1].body;
    expect(body.get('client_id')).toBe('Ov23liUserOwnApp');
  });
});
