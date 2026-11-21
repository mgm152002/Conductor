import { z } from 'zod';
import type { McpDiscoveryEntry, McpInstallResult, McpInvocationResult, McpOAuthChallenge, McpServer } from './mcp';
import type { McpMarketplaceEntry } from './mcp-marketplace';
import type { CliMcpOverview, CliMcpSyncReport } from './cli-mcp';
import { AttachmentIdsSchema } from './attachments';
import { AGENT_ICON_PATTERN, MAX_AGENT_ICON_CHARS, type AgentGroup, type AgentGroupMessage, type SandboxAgent, type SandboxStatus } from './sandbox-agents';
import { FlowInputSchema, type AgentFlow, type FlowInput, type FlowRun } from './agent-flows';
import type { AgentModelCatalog } from './agent-models';
import type { AutoExecuteRule, ImprovementProposal, PerformanceBaseline, Suggestion } from './domain';
import type { LearningConfig, LearningRun, LearningStatus, RoutingPurgeResult } from './learning-contract';

// Validated IPC for integrations: stored secrets, MCP servers, remote SSH
// hosts, proactive suggestions, self-learning proposals and the agent list.
// Secret values cross IPC only when the user enters them (connector forms);
// nothing here returns a secret value.

const id = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();
const sandboxAgentInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300),
  instructions: z.string().max(8000),
  clis: z.array(z.string().trim().regex(/^[\w:.-]{1,200}$/)).min(1).max(10),
  models: z.record(z.string().regex(/^[\w:.-]{1,200}$/), z.object({
    model: z.string().regex(/^[\w./:@-]{1,100}$/).optional(),
    effort: z.string().regex(/^[a-z]{2,12}$/).optional(),
  })).optional(),
  tools: z.array(z.enum(['browser', 'shell', 'files', 'code', 'documents'])).min(1).max(5),
  approval: z.enum(['risky', 'all', 'none']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  icon: z.string().max(MAX_AGENT_ICON_CHARS).regex(AGENT_ICON_PATTERN).optional(),
});
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

  // Sandbox agents and their sandbox containers.
  'agents.sandbox.list': z.void(),
  'agents.sandbox.create': sandboxAgentInput,
  'agents.sandbox.update': sandboxAgentInput.extend({ id: uuid }),
  'agents.sandbox.remove': z.object({ id: uuid }),
  'agents.sandbox.threads': z.void(),
  'agents.workspace': z.void(),
  'agents.group.list': z.void(),
  'flows.list': z.void(),
  'flows.save': FlowInputSchema,
  'flows.remove': z.object({ id: uuid }),
  'flows.run': z.object({ id: uuid, input: z.string().max(10_000).optional() }),
  'flows.runs': z.object({ flowId: uuid }),
  'flows.stop': z.object({ runId: uuid }),
  'flows.history': z.void(),
  'flows.draft': z.object({ description: z.string().trim().min(3).max(4000) }),
  'mail.status': z.void(),
  'mail.connect': z.object({ apiKey: z.string().trim().min(8).max(200), owner: z.string().trim().min(3).max(200) }),
  'mail.disconnect': z.void(),
  'agents.group.create': z.object({ name: z.string().max(60), agentIds: z.array(uuid).min(2).max(12) }),
  'agents.group.remove': z.object({ id: uuid }),
  'agents.group.messages': z.object({ groupId: uuid }),
  'agents.group.send': z.object({
    groupId: uuid, workspaceId: uuid.optional(), text: z.string().trim().min(1).max(10_000),
    agentIds: z.array(uuid).min(1).max(12).optional(),
    context: z.string().max(20_000).optional(),
    attachmentIds: AttachmentIdsSchema.optional(),
    /** For members still working: steer stops them to answer now, queue waits (the default). */
    mode: z.enum(['steer', 'queue']).optional(),
    /** Run this message on this CLI for the members that have it (others keep their own first CLI). */
    agentId: z.string().trim().regex(/^[\w:.-]{1,200}$/).optional(),
    runOptions: z.object({ main: z.object({ model: z.string().regex(/^[\w./:@-]{1,100}$/).optional(), effort: z.string().regex(/^[a-z]{2,12}$/).optional() }).optional() }).optional(),
  }),
  'threadTiers.get': z.void(),
  'threadTiers.put': z.object({
    key: z.string().regex(/^[\w-]{1,64}$/),
    pref: z.object({ mode: z.enum(['settled', 'snoozed']), seenUpdatedAt: z.string().max(40), snoozedUntil: z.string().max(40).optional() }).nullable(),
  }),
  'threadTiers.adopt': z.record(z.string(), z.unknown()),
  'phone.status': z.void(),
  'phone.start': z.void(),
  'phone.newCode': z.void(),
  'phone.signOut': z.void(),
  'phone.stop': z.void(),
  'sandbox.status': z.void(),
  'sandbox.pull': z.void(),
  'sandbox.viewer': z.object({ agentId: uuid }),
  'sandbox.groupViewer': z.object({ groupId: uuid }),
  'sandbox.flowViewer': z.object({ flowId: uuid }),
  // A remote WebDriver browser (Selenium hub) for one agent or one flow.
  'cloudBrowser.get': z.object({ scope: z.string().regex(/^(agent|flow):[0-9a-f-]{36}$/i) }),
  'cloudBrowser.save': z.object({ scope: z.string().regex(/^(agent|flow):[0-9a-f-]{36}$/i), url: z.string().trim().min(1).max(2000), apiKey: z.string().trim().max(2000).optional() }),
  'cloudBrowser.load': z.object({ scope: z.string().regex(/^(agent|flow):[0-9a-f-]{36}$/i) }),
  'cloudBrowser.remove': z.object({ scope: z.string().regex(/^(agent|flow):[0-9a-f-]{36}$/i) }),
  'cloudBrowser.test': z.object({ scope: z.string().regex(/^(agent|flow):[0-9a-f-]{36}$/i), url: z.string().trim().max(2000).optional(), apiKey: z.string().trim().max(2000).optional() }),
  'sandbox.stop': z.object({ agentId: uuid }),
  'sandbox.clearBrowser': z.object({ agentId: z.string().min(1) }),

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

export interface CloudBrowserInfo { configured: boolean; host?: string }
export interface CloudBrowserTest { ok: boolean; browser?: string; error?: string }
export interface AgentOption { id: string; name: string; available: boolean; remote: boolean }
export interface SecretInfo { id: string; label: string; owner?: string; createdAt: string }
export interface RemoteHostView {
  id: string; name: string; host: string; remoteDir: string; installIfMissing: boolean; enabled: boolean; available: boolean; createdAt: string;
}
export interface RemoteTestResult { connected: boolean; agentInstalled: boolean; error?: string }
export interface AgentStat { adapterId: string; stats: PerformanceBaseline }

export interface IntegrationsBridge {
  threadTiers: {
    get(): Promise<Record<string, { mode: 'settled' | 'snoozed'; seenUpdatedAt: string; snoozedUntil?: string }>>;
    put(key: string, pref: { mode: 'settled' | 'snoozed'; seenUpdatedAt: string; snoozedUntil?: string } | null): Promise<Record<string, { mode: 'settled' | 'snoozed'; seenUpdatedAt: string; snoozedUntil?: string }>>;
    adopt(local: Record<string, unknown>): Promise<Record<string, { mode: 'settled' | 'snoozed'; seenUpdatedAt: string; snoozedUntil?: string }>>;
  };
  phone: {
    status(): Promise<import('./phone-control').PhoneControlStatus>;
    start(): Promise<import('./phone-control').PhoneControlStatus>;
    newCode(): Promise<import('./phone-control').PhoneControlStatus>;
    signOut(): Promise<import('./phone-control').PhoneControlStatus>;
    stop(): Promise<import('./phone-control').PhoneControlStatus>;
  };
  agents: { list(): Promise<AgentOption[]>; models(agentId: string, refresh?: boolean): Promise<AgentModelCatalog> };
  secrets: { list(): Promise<SecretInfo[]>; delete(id: string): Promise<void> };
  sandboxAgents: {
    list(): Promise<SandboxAgent[]>;
    create(input: IntegrationRequest<'agents.sandbox.create'>): Promise<SandboxAgent>;
    update(input: IntegrationRequest<'agents.sandbox.update'>): Promise<SandboxAgent>;
    remove(id: string): Promise<void>;
    /** Thread id → id of the agent that runs it. */
    threads(): Promise<Record<string, string>>;
    groups(): Promise<{ groups: AgentGroup[]; groupThreads: Record<string, string> }>;
    /** The hidden workspace agent chats use when no project is chosen. */
    workspace(): Promise<string>;
    createGroup(input: IntegrationRequest<'agents.group.create'>): Promise<AgentGroup>;
    removeGroup(id: string): Promise<void>;
    groupMessages(groupId: string): Promise<AgentGroupMessage[]>;
    sendGroup(input: IntegrationRequest<'agents.group.send'>): Promise<AgentGroupMessage>;
  };
  flows: {
    list(): Promise<AgentFlow[]>;
    save(input: IntegrationRequest<'flows.save'>): Promise<AgentFlow>;
    remove(id: string): Promise<void>;
    /** Start a run now; resolves once its first steps are started. */
    run(id: string, input?: string): Promise<FlowRun>;
    /** The flow's recent runs, newest first. */
    runs(flowId: string): Promise<FlowRun[]>;
    /** Stop a run that is going. */
    stopRun(runId: string): Promise<FlowRun>;
    /** Recent runs of every flow, newest first. */
    history(): Promise<Array<FlowRun & { flowName: string; labels: Record<string, string> }>>;
    /** A flow written from a description (not saved). */
    draft(description: string): Promise<Omit<FlowInput, 'id'>>;
  };
  mail: {
    status(): Promise<{ configured: boolean; inbox?: string; owner?: string; listening: boolean }>;
    connect(input: IntegrationRequest<'mail.connect'>): Promise<{ configured: boolean; inbox?: string; owner?: string; listening: boolean }>;
    disconnect(): Promise<void>;
  };
  /** A remote WebDriver browser for an agent (`agent:<id>`) or a flow (`flow:<id>`); the key stays in the Keychain. */
  cloudBrowser: {
    get(scope: string): Promise<CloudBrowserInfo>;
    save(scope: string, url: string, apiKey?: string): Promise<CloudBrowserInfo>;
    /** The saved URL and key, to fill the settings form; null when none is saved. */
    load(scope: string): Promise<{ url: string; apiKey?: string } | null>;
    remove(scope: string): Promise<void>;
    /** Try a connection: the one given, or the saved one when url is omitted. */
    test(scope: string, url?: string, apiKey?: string): Promise<CloudBrowserTest>;
  };
  sandbox: {
    status(): Promise<SandboxStatus>;
    /** Start downloading the sandbox image; poll status for progress. */
    pull(): Promise<SandboxStatus>;
    stop(agentId: string): Promise<void>;
    /** Forget the logins saved in a sandbox's browser (stops that sandbox). */
    clearBrowser(agentId: string): Promise<void>;
    /** Open a window showing the agent's sandbox desktop (live browser). */
    openViewer(agentId: string): Promise<void>;
    /** Open a window for each running sandbox of a group chat (the shared one, or its members' own). */
    openGroupViewer(groupId: string): Promise<void>;
    /** Open a window on the sandbox a flow's steps share. */
    openFlowViewer(flowId: string): Promise<void>;
  };
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
