import { z } from 'zod';
import type { McpDiscoveryEntry, McpInvocationResult, McpServer } from './mcp';
import type { AgentModelCatalog } from './agent-models';
import type { AutoExecuteRule, ImprovementProposal, PerformanceBaseline, Suggestion } from './domain';
import type { LearningConfig, LearningRun, LearningStatus, RoutingPurgeResult } from './learning-contract';

// Validated IPC for integrations: stored secrets, MCP servers, remote SSH
// hosts, proactive suggestions, self-learning proposals and the agent list.
// Secret values cross IPC only when the user enters them (connector forms);
// nothing here returns a secret value.

const id = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();

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
