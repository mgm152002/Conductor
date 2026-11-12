import { z } from 'zod';
import type { McpDiscoveryEntry, McpInstallResult, McpInvocationResult, McpOAuthChallenge, McpServer } from './mcp';
import type { McpMarketplaceEntry } from './mcp-marketplace';
import type { CliMcpOverview, CliMcpSyncReport } from './cli-mcp';
import type { AgentModelCatalog } from './agent-models';
import type { AutoExecuteRule, ImprovementProposal, PerformanceBaseline, Suggestion } from './domain';
import type { LearningConfig, LearningRun, LearningStatus, RoutingPurgeResult } from './learning-contract';

// Validated IPC for integrations: stored secrets, MCP servers, remote SSH
// hosts, proactive suggestions, self-learning proposals and the agent list.
// Secret values cross IPC only when the user enters them (connector forms);
// nothing here returns a secret value.

const id = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();
const mcpCli = z.enum(['claude-code', 'codex', 'opencode', 'antigravity', 'kiro']);
const mcpKey = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);

export const INTEGRATION_SCHEMAS = {
  'agents.list': z.void(),
  'agents.models': z.object({ agentId: z.string().trim().regex(/^[\w:.-]{1,200}$/), refresh: z.boolean().optional() }),

  'secret.list': z.void(),
  'secret.delete': z.object({ id: z.string().regex(/^sec_[a-f0-9]{32}$/) }),

  'mcp.list': z.void(),
  'mcp.discover': z.void(),
  'mcp.add': z.object({ name: z.string().trim().min(1).max(255), endpoint: z.string().trim().min(1).max(4096) }),
  'mcp.approve': z.object({ id }),
  'mcp.disable': z.object({ id }),
  'mcp.remove': z.object({ id }),
  'mcp.checkHealth': z.object({ id }),
  'mcp.invoke': z.object({ id, tool: z.string().trim().min(1).max(200), args: z.record(z.string(), z.unknown()).optional() }),
  'mcp.marketplace': z.object({ search: z.string().trim().max(100).optional() }).optional(),
  'mcp.install': z.object({ entryId: z.string().trim().regex(/^[\w][\w./-]{0,199}$/) }),
  'mcp.oauth.start': z.object({ id }),
  'mcp.oauth.complete': z.object({ id }),
  'mcp.oauth.cancel': z.object({ id }),
  'mcp.setSecret': z.object({ id, name: z.string().trim().regex(/^[A-Za-z0-9_]{1,64}$/), value: z.string().min(1).max(65536) }),
  'mcp.clearSecret': z.object({ id, name: z.string().trim().regex(/^[A-Za-z0-9_]{1,64}$/) }),
  // MCP servers in each agent CLI's own configuration.
  'mcp.cli.overview': z.object({ sync: z.boolean().optional() }).optional(),
  'mcp.cli.sync': z.void(),
  'mcp.cli.setAutoSync': z.object({ enabled: z.boolean() }),
  'mcp.cli.add': z.object({
    name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
    endpoint: z.string().trim().min(1).max(4096),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(8192)).optional(),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,128}$/), z.string().max(8192)).optional(),
    clis: z.array(mcpCli).min(1).max(5).optional(),
  }),
  'mcp.cli.install': z.object({ key: mcpKey, cli: mcpCli }),
  'mcp.cli.remove': z.object({ key: mcpKey, cli: mcpCli }),
  'mcp.cli.removeEverywhere': z.object({ key: mcpKey }),

  'remote.list': z.void(),
  'remote.add': z.object({
    name: z.string().trim().max(255),
    host: z.string().trim().min(1).max(255),
    remoteDir: z.string().trim().min(1).max(1024),
    installIfMissing: z.boolean(),
  }),
  'remote.remove': z.object({ id: uuid }),
  'remote.setEnabled': z.object({ id: uuid, enabled: z.boolean() }),
  'remote.test': z.object({ id: uuid }),

  'suggestion.list': z.void(),
  'suggestion.confirm': z.object({ id: uuid, always: z.boolean().optional() }),
  'suggestion.dismiss': z.object({ id: uuid }),
  'suggestion.rules': z.void(),
  'suggestion.removeRule': z.object({ actionKind: z.string().trim().min(1).max(100) }),

  'learning.proposals': z.void(),
  'learning.approve': z.object({ id: uuid }),
  'learning.reject': z.object({ id: uuid }),
  'learning.stats': z.void(),
  'learning.status': z.void(),
  'learning.setConfig': z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(['manual', 'auto']).optional(),
    analyzerAgentId: z.string().trim().regex(/^[\w:.-]{1,200}$/).optional(),
    // '' clears the pinned model back to Default / Auto.
    analyzerModel: z.union([z.literal(''), z.string().trim().regex(/^[\w./:@-]{1,100}$/)]).optional(),
  }),
  'learning.runNow': z.void(),
  'learning.purgeRoutingApprovals': z.object({
    // Required confirmation; the renderer sends it only after the user
    // confirms in the purge dialog, so old approvals can't be wiped by a
    // stray or unconfirmed invoke.
    confirmed: z.literal(true),
  }),
} as const;

export type IntegrationRequest<C extends keyof typeof INTEGRATION_SCHEMAS> = z.infer<(typeof INTEGRATION_SCHEMAS)[C]>;

export interface AgentOption { id: string; name: string; available: boolean; remote: boolean }
export interface SecretInfo { id: string; label: string; owner?: string; createdAt: string }
export interface RemoteHostView {
  id: string; name: string; host: string; remoteDir: string; installIfMissing: boolean; enabled: boolean; available: boolean; createdAt: string;
}
export interface RemoteTestResult { connected: boolean; agentInstalled: boolean; error?: string }
export interface AgentStat { adapterId: string; stats: PerformanceBaseline }

export interface IntegrationsBridge {
  agents: { list(): Promise<AgentOption[]>; models(agentId: string, refresh?: boolean): Promise<AgentModelCatalog> };
  secrets: { list(): Promise<SecretInfo[]>; delete(id: string): Promise<void> };
  mcp: {
    list(): Promise<McpServer[]>;
    discover(): Promise<McpDiscoveryEntry[]>;
    add(input: IntegrationRequest<'mcp.add'>): Promise<McpServer>;
    approve(id: string): Promise<McpServer>;
    disable(id: string): Promise<McpServer>;
    remove(id: string): Promise<void>;
    checkHealth(id: string): Promise<McpServer>;
    invoke(input: IntegrationRequest<'mcp.invoke'>): Promise<McpInvocationResult>;
    /** The mcpservers.org catalog (optionally searched). */
    marketplace(search?: string): Promise<readonly McpMarketplaceEntry[]>;
    /** One-click install; OAuth-capable servers immediately open sign-in. */
    install(entryId: string): Promise<McpInstallResult>;
    startOAuth(id: string): Promise<McpOAuthChallenge>;
    completeOAuth(id: string): Promise<McpServer>;
    cancelOAuth(id: string): Promise<void>;
    /** Save a credential (API key) for a server slot into the Keychain. */
    setSecret(input: IntegrationRequest<'mcp.setSecret'>): Promise<McpServer>;
    /** Remove a saved credential from the Keychain. */
    clearSecret(input: IntegrationRequest<'mcp.clearSecret'>): Promise<McpServer>;
    cli: {
      /** Servers in every installed CLI; `sync` first copies missing ones across. */
      overview(options?: { sync?: boolean }): Promise<CliMcpOverview>;
      sync(): Promise<CliMcpSyncReport>;
      setAutoSync(enabled: boolean): Promise<CliMcpOverview>;
      add(input: IntegrationRequest<'mcp.cli.add'>): Promise<CliMcpOverview>;
      install(input: IntegrationRequest<'mcp.cli.install'>): Promise<CliMcpOverview>;
      remove(input: IntegrationRequest<'mcp.cli.remove'>): Promise<CliMcpOverview>;
      removeEverywhere(key: string): Promise<CliMcpOverview>;
    };
  };
  remote: {
    list(): Promise<RemoteHostView[]>;
    add(input: IntegrationRequest<'remote.add'>): Promise<RemoteHostView>;
    remove(id: string): Promise<void>;
    setEnabled(input: IntegrationRequest<'remote.setEnabled'>): Promise<RemoteHostView>;
    test(id: string): Promise<RemoteTestResult>;
  };
  suggestions: {
    list(): Promise<Suggestion[]>;
    confirm(input: IntegrationRequest<'suggestion.confirm'>): Promise<Suggestion>;
    dismiss(id: string): Promise<Suggestion>;
    rules(): Promise<AutoExecuteRule[]>;
    removeRule(actionKind: string): Promise<void>;
  };
  learning: {
    proposals(): Promise<ImprovementProposal[]>;
    approve(id: string): Promise<ImprovementProposal>;
    reject(id: string): Promise<ImprovementProposal>;
    stats(): Promise<AgentStat[]>;
    status(): Promise<LearningStatus>;
    setConfig(input: Partial<LearningConfig>): Promise<LearningConfig>;
    runNow(): Promise<LearningRun>;
    purgeRoutingApprovals(): Promise<RoutingPurgeResult>;
  };
}
