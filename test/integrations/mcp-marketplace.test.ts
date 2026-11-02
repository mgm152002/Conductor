import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { McpRegistry } from '@main/mcp/mcp-registry';
import { McpService, type MarketplaceCatalog } from '@main/mcp/mcp-service';
import { SdkMcpTransport } from '@main/mcp/sdk-transport';
import { deriveInstallFromDetail, marketplaceEntryFromCard } from '@shared/mcp-marketplace';
import { acpMcpServers } from '@main/adapters/acp-agent-adapter';

let dir: string;
let store: SqliteStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-mkt-'));
  store = new SqliteStore(join(dir, 'app.db'));
  await store.migrate();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const CARDS = [
  {
    slug: 'github/github-mcp-server', name: 'GitHub MCP', official: true,
    lines: ['GitHub MCP', 'Version Control', 'official', '34k', 'Official GitHub MCP server for repository search and pull requests.', 'github/github-mcp-server'],
  },
  {
    slug: 'someone/video-gen', name: 'Video Gen', official: false,
    lines: ['Video Gen', 'AI Generation', 'Generate videos from prompts.', 'someone/video-gen'],
  },
];

const fakeCatalog: MarketplaceCatalog = {
  search: async () => CARDS.map(marketplaceEntryFromCard),
  detail: async (entry) => entry.id === 'github/github-mcp-server'
    ? { codeBlocks: ['{\n  "mcpServers": {\n    "github": {\n      "type": "http",\n      "url": "https://api.githubcopilot.com/mcp/"\n    }\n  }\n}'] }
    : { codeBlocks: ["npx add-mcp 'https://mcp.example.ai/mcp'"] },
};

function serviceWith(catalog: MarketplaceCatalog): { mcp: McpService; registry: McpRegistry } {
  const transport = new SdkMcpTransport([]);
  const registry = new McpRegistry(store, new AuditLog(store), { transport });
  return { mcp: new McpService(registry, transport, catalog), registry };
}

describe('mcpservers.org marketplace', () => {
  it('maps listing cards: checkmark only for official, stars, publisher, real category', () => {
    const official = marketplaceEntryFromCard(CARDS[0]!);
    expect(official).toMatchObject({ name: 'GitHub MCP', verified: true, category: 'Version Control', stars: '34k', publisher: 'github', websiteUrl: 'https://mcpservers.org/servers/github/github-mcp-server' });
    const community = marketplaceEntryFromCard(CARDS[1]!);
    expect(community.verified).toBe(false);
    expect(community.description).toBe('Generate videos from prompts.');
  });

  it('derives install endpoints from detail-page config blocks', () => {
    expect(deriveInstallFromDetail(['{"mcpServers":{"x":{"command":"npx","args":["-y","srv","a b"]}}}']))
      .toMatchObject({ installable: true, endpoint: "npx -y srv 'a b'" });
    expect(deriveInstallFromDetail(["npx add-mcp 'https://mcp.example.ai/mcp'"]))
      .toMatchObject({ installable: true, endpoint: 'https://mcp.example.ai/mcp' });
    expect(deriveInstallFromDetail(['just prose, no config']).installable).toBe(false);
  });

  it('installs by slug from the detail page, untrusted + stopped, and dedupes', async () => {
    const { mcp, registry } = serviceWith(fakeCatalog);
    const entries = await mcp.marketplace('github');
    expect(entries.map((e) => e.id)).toContain('github/github-mcp-server');
    const installed = await mcp.installMarketplace('github/github-mcp-server');
    expect(installed).toMatchObject({ name: 'GitHub MCP', trustStatus: 'untrusted', enablement: 'disabled', endpoint: 'https://api.githubcopilot.com/mcp/' });
    expect((await mcp.installMarketplace('github/github-mcp-server')).id).toBe(installed.id);
    expect(registry.list()).toHaveLength(1);
    expect(installed.endpoint).not.toContain('~/');
    expect(homedir()).toBeTruthy();
    await expect(mcp.installMarketplace('no/such-server')).rejects.toThrow(/not found/);
  });

  it('keeps OAuth remote servers enabled when Conductor cannot list their tools', async () => {
    const registryTransport = {
      discover: async () => [],
      probeHealth: async () => ({ healthy: false }),
      invoke: async () => null,
    };
    const registry = new McpRegistry(store, new AuditLog(store), { transport: registryTransport });
    const sdkStub = {
      listTools: async () => { throw new Error('Streamable HTTP error: Error POSTing to endpoint: bad request: missing required Authorization header'); },
      disconnect: async () => undefined,
    } as unknown as SdkMcpTransport;
    const mcp = new McpService(registry, sdkStub, fakeCatalog);
    await mcp.marketplace();
    const installed = await mcp.installMarketplace('someone/video-gen');
    const approved = await mcp.approve(installed.id);
    expect(approved.enablement).toBe('enabled');
    await expect(mcp.forAgents()).resolves.toEqual([{ key: installed.id.replace(/-/g, '_'), url: 'https://mcp.example.ai/mcp' }]);
  });
});

describe('API keys', () => {
  it('detects the placeholder, stores the value in secrets, and substitutes it for agents', async () => {
    const transport = new SdkMcpTransport([]);
    const registry = new McpRegistry(store, new AuditLog(store), { transport });
    const values = new Map<string, string>();
    let seq = 0;
    const secrets = {
      put: async ({ value }: { value: string }) => { seq += 1; const id = `sec_${seq}`; values.set(id, value); return { id }; },
      delete: async (id: string) => { values.delete(id); },
      resolve: async (id: string) => values.get(id),
    };
    const keyedCatalog: MarketplaceCatalog = {
      search: async () => [marketplaceEntryFromCard({ slug: 'acme/video', name: 'Acme Video', official: false, lines: ['Acme Video', 'AI Generation', 'Makes videos.', 'acme/video'] })],
      detail: async () => ({ codeBlocks: ["npx mcp-remote https://mcp.example.ai/ --header 'Authorization: Bearer YOUR_API_KEY_HERE'"] }),
    };
    const mcp = new McpService(registry, transport, keyedCatalog, secrets);
    await mcp.marketplace();
    const installed = await mcp.installMarketplace('acme/video');
    expect(installed.endpoint).toContain('YOUR_API_KEY_HERE');
    expect(installed.secretSlots).toEqual([{ name: 'API_KEY', set: false }]);
    // Renderer-bound records carry names only, never values.
    expect(JSON.stringify(registry.list())).not.toContain('sk-live');

    const withKey = await mcp.setSecret(installed.id, 'API_KEY', 'sk-live-123');
    expect(withKey.secretSlots).toEqual([{ name: 'API_KEY', set: true }]);
    registry.approve(installed.id, 'user');
    registry.enable(installed.id);
    const agents = await mcp.forAgents();
    expect(agents[0]?.args?.join(' ')).toContain('Bearer sk-live-123');
    expect(JSON.stringify(registry.list())).not.toContain('sk-live-123');

    await mcp.clearSecret(installed.id, 'API_KEY');
    expect(registry.getOrThrow(installed.id).secretSlots).toEqual([{ name: 'API_KEY', set: false }]);
    await expect(mcp.setSecret(installed.id, 'NOPE', 'x')).rejects.toThrow(/does not need/);
  });

  it('detects placeholders in manually added endpoints', () => {
    const transport = new SdkMcpTransport([]);
    const registry = new McpRegistry(store, new AuditLog(store), { transport });
    const mcp = new McpService(registry, transport);
    const added = mcp.add({ name: 'Keyed', endpoint: "npx mcp-remote https://mcp.example.ai/ --header 'Authorization: Bearer ${MY_TOKEN}'" });
    expect(added.secretSlots).toEqual([{ name: 'MY_TOKEN', set: false }]);
  });
});

describe('OAuth credentials', () => {
  it('adopts an OAuth-capable server that was installed before OAuth support existed', async () => {
    const transport = new SdkMcpTransport([]);
    const registry = new McpRegistry(store, new AuditLog(store), { transport });
    const old = registry.register({ id: 'existing-remote', name: 'Existing remote', endpoint: 'https://api.githubcopilot.com/mcp/' });
    registry.approve(old.id, 'user');
    registry.enable(old.id);
    expect(old.authentication).toBeUndefined();
    const oauth = {
      supports: (endpoint: string) => endpoint === old.endpoint,
      start: async () => ({ serverId: old.id, providerName: 'Provider', verificationUrl: 'https://auth.example/device', userCode: 'CODE', expiresAt: Date.now() + 60_000 }),
      complete: async () => ({ accessToken: 'token', tokenType: 'bearer' }), cancel: () => undefined,
    };

    const mcp = new McpService(registry, transport, fakeCatalog, undefined, oauth);

    expect(mcp.list()[0]).toMatchObject({ authentication: { type: 'oauth', status: 'sign_in_required' }, enablement: 'disabled' });
    await expect(mcp.forAgents()).resolves.toEqual([]);
  });

  it('rejects and clears an OAuth token that the MCP endpoint refuses', async () => {
    const transport = new SdkMcpTransport([]);
    transport.listTools = async () => { throw new Error('401 Unauthorized'); };
    const registry = new McpRegistry(store, new AuditLog(store), { transport });
    const values = new Map<string, string>();
    const secrets = {
      put: async ({ value }: { value: string }) => { values.set('bad-token', value); return { id: 'bad-token' }; },
      delete: async (id: string) => { values.delete(id); }, resolve: async (id: string) => values.get(id),
    };
    const oauth = {
      supports: (endpoint: string) => endpoint === 'https://api.githubcopilot.com/mcp/',
      start: async (target: { id: string }) => ({ serverId: target.id, providerName: 'Provider', verificationUrl: 'https://auth.example/device', userCode: 'CODE', expiresAt: Date.now() + 60_000 }),
      complete: async () => ({ accessToken: 'rejected-token', tokenType: 'bearer' }), cancel: () => undefined,
    };
    const mcp = new McpService(registry, transport, fakeCatalog, secrets, oauth);
    await mcp.marketplace();
    const install = await mcp.installAndAuthorize('github/github-mcp-server');

    await expect(mcp.completeOAuth(install.server.id)).rejects.toThrow(/Could not start or reach/);
    expect(mcp.list()[0]).toMatchObject({ authentication: { status: 'sign_in_required' }, enablement: 'disabled' });
    expect(values.size).toBe(0);
  });

  it('stores the bearer token outside renderer-visible records and resolves it only in main', async () => {
    const transport = new SdkMcpTransport([]);
    transport.listTools = async () => [{ id: 'list_repositories', title: 'List repositories' }];
    transport.probeHealth = async () => ({ healthy: true });
    const registry = new McpRegistry(store, new AuditLog(store), { transport });
    const values = new Map<string, string>();
    const secrets = {
      put: async ({ value }: { value: string }) => { values.set('oauth-secret', value); return { id: 'oauth-secret' }; },
      delete: async (id: string) => { values.delete(id); },
      resolve: async (id: string) => values.get(id),
    };
    const oauth = {
      supports: (endpoint: string) => endpoint === 'https://api.githubcopilot.com/mcp/',
      start: async () => ({ serverId: 'github-1', providerName: 'Test OAuth', verificationUrl: 'https://auth.example/device', userCode: 'CODE', expiresAt: Date.now() + 60_000 }),
      complete: async () => ({ accessToken: 'gho_super_secret', tokenType: 'bearer' }),
      cancel: () => undefined,
    };
    const mcp = new McpService(registry, transport, fakeCatalog, secrets, oauth);
    await mcp.marketplace();
    const install = await mcp.installAndAuthorize('github/github-mcp-server');
    const installed = install.server;

    expect(install.oauth).toMatchObject({ providerName: 'Test OAuth', userCode: 'CODE' });
    expect(installed.authentication).toEqual({ type: 'oauth', status: 'sign_in_required' });
    expect(installed.secretSlots).toBeUndefined();

    const connected = await mcp.completeOAuth(installed.id);
    expect(connected.authentication).toEqual({ type: 'oauth', status: 'connected' });
    expect(connected).toMatchObject({ trustStatus: 'trusted', enablement: 'enabled', health: 'healthy' });
    expect(connected.capabilities).toEqual([{ id: 'list_repositories', title: 'List repositories' }]);
    expect(JSON.stringify(registry.list())).not.toContain('gho_super_secret');
    expect(JSON.stringify(registry.list())).not.toContain('oauth-secret');
    await expect(mcp.resolveEffective(connected)).resolves.toMatchObject({ bearerToken: 'gho_super_secret' });
    await expect(mcp.forAgents()).resolves.toEqual([expect.objectContaining({
      url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer gho_super_secret' },
    })]);
  });
});

describe('ACP exposure', () => {
  it('converts approved servers to ACP shape for OpenCode and Kiro', () => {
    expect(acpMcpServers([
      { key: 'video', url: 'https://mcp.example.ai/mcp' },
      { key: 'files', command: 'npx', args: ['-y', 'srv'] },
    ])).toEqual([
      { name: 'video', type: 'http', url: 'https://mcp.example.ai/mcp', headers: [] },
      { name: 'files', command: 'npx', args: ['-y', 'srv'], env: [] },
    ]);
    expect(acpMcpServers(undefined)).toEqual([]);
  });
});
