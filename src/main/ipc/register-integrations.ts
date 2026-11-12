import type { WebContents } from 'electron';
import type { Suggestion } from '@shared/domain';
import { compareAgentPreference } from '@shared/agent-preference';
import { INTEGRATION_SCHEMAS, type RemoteHostView } from '@shared/integrations-contract';
import type { Registry } from '../registry/registry';
import type { SecretStore } from '../secrets/secret-store';
import type { CliMcpManager } from '../mcp/cli-mcp';
import type { SandboxManager } from '../sandbox/sandbox-manager';
import type { SandboxAgentService } from '../sandbox/sandbox-agents';
import { openSandboxViewer } from '../sandbox/sandbox-viewer';
import type { McpService } from '../mcp/mcp-service';
import type { RemoteHost, RemoteHostService } from '../adapters/remote-hosts';
import type { ProactiveAssistant } from '../domain/proactive-assistant-service';
import type { SelfLearningEngine } from '../domain/self-learning-service';
import type { LearningLoop } from '../domain/learning-loop';
import { ORCHESTRATOR_SUBJECT } from '../domain/proactive-signals';
import type { SuggestionEmitter } from '../orchestrator/suggestion-emitter';
import type { IpcRouter } from './router';
import type { ModelCatalogService } from '../agents/model-catalog';
import type { LearningCronService } from '../domain/learning-cron';

/** Relays surfaced suggestions to the renderer (non-blocking notice). */
export class IpcSuggestionEmitter implements SuggestionEmitter {
  private getWebContents: () => WebContents | null = () => null;
  constructor(private readonly router: IpcRouter) {}
  setWebContentsResolver(resolver: () => WebContents | null): void { this.getWebContents = resolver; }
  emit(suggestion: Suggestion): void {
    const target = this.getWebContents();
    if (target === null || target.isDestroyed()) return;
    try { this.router.emit(target, 'suggestion.surfaced', suggestion); } catch { /* best effort */ }
  }
}

export interface IntegrationDeps {
  /** MCP servers in each agent CLI's own configuration. */
  cliMcp: CliMcpManager;
  sandboxes: SandboxManager;
  phone: import('../phone/phone-control').PhoneControl;
  tiers: import('../phone/thread-tier-store').ThreadTierStore;
  sandboxAgents: SandboxAgentService;
  router: IpcRouter;
  registry: Registry;
  secrets: SecretStore;
  mcp: McpService;
  remote: RemoteHostService;
  assistant: ProactiveAssistant;
  learning: SelfLearningEngine;
  learningLoop: LearningLoop;
  learningCron?: LearningCronService;
  /** Models and effort levels each agent CLI offers. */
  modelCatalogs?: ModelCatalogService;
}

export function registerIntegrationHandlers(deps: IntegrationDeps): void {
  const { router } = deps;
  const S = INTEGRATION_SCHEMAS;
  const remoteView = (host: RemoteHost): RemoteHostView => ({ ...host, available: deps.remote.available(host.id) });

  // Preference order, not registration order: the composer's plan-mode picker
  // and casual chat pick the first available entry, so this decides the default
  // planner. See AGENT_PREFERENCE_ORDER.
  router.handle('agents.list', S['agents.list'], () =>
    deps.registry.listAdapters()
      .filter((adapter) => adapter.capabilities.some((c) => c.id === `objective.fulfill.${adapter.id}`))
      .sort((a, b) => compareAgentPreference(a.id, b.id))
      .map((adapter) => ({ id: adapter.id, name: adapter.name, available: adapter.available, remote: adapter.class === 'remote_execution' })));

  router.handle('agents.models', S['agents.models'], (_e, input) =>
    deps.modelCatalogs?.get(input.agentId, input.refresh === true) ?? Promise.resolve({ agentId: input.agentId, models: [], efforts: [], source: 'none' as const }));

  router.handle('secret.list', S['secret.list'], () => deps.secrets.list());
  router.handle('secret.delete', S['secret.delete'], (_e, input) => deps.secrets.delete(input.id));

  router.handle('mcp.list', S['mcp.list'], () => deps.mcp.list());
  router.handle('mcp.discover', S['mcp.discover'], () => deps.mcp.discover());
  router.handle('mcp.add', S['mcp.add'], (_e, input) => deps.mcp.add(input));
  router.handle('mcp.approve', S['mcp.approve'], (_e, input) => deps.mcp.approve(input.id));
  router.handle('mcp.disable', S['mcp.disable'], (_e, input) => deps.mcp.disable(input.id));
  router.handle('mcp.remove', S['mcp.remove'], (_e, input) => deps.mcp.remove(input.id));
  router.handle('mcp.checkHealth', S['mcp.checkHealth'], (_e, input) => deps.mcp.checkHealth(input.id));
  router.handle('mcp.invoke', S['mcp.invoke'], (_e, input) => deps.mcp.invoke({ id: input.id, tool: input.tool, ...(input.args !== undefined ? { args: input.args } : {}) }));
  router.handle('mcp.marketplace', S['mcp.marketplace'], (_e, input) => deps.mcp.marketplace(input?.search));
  router.handle('mcp.install', S['mcp.install'], (_e, input) => deps.mcp.installAndAuthorize(input.entryId));
  router.handle('mcp.oauth.start', S['mcp.oauth.start'], (_e, input) => deps.mcp.startOAuth(input.id));
  router.handle('mcp.oauth.complete', S['mcp.oauth.complete'], (_e, input) => deps.mcp.completeOAuth(input.id));
  router.handle('mcp.oauth.cancel', S['mcp.oauth.cancel'], (_e, input) => { deps.mcp.cancelOAuth(input.id); });
  router.handle('mcp.setSecret', S['mcp.setSecret'], (_e, input) => deps.mcp.setSecret(input.id, input.name, input.value));
  router.handle('mcp.clearSecret', S['mcp.clearSecret'], (_e, input) => deps.mcp.clearSecret(input.id, input.name));
  router.handle('agents.sandbox.list', S['agents.sandbox.list'], () => deps.sandboxAgents.list());
  router.handle('agents.sandbox.create', S['agents.sandbox.create'], (_e, input) => deps.sandboxAgents.create(input));
  router.handle('agents.sandbox.update', S['agents.sandbox.update'], (_e, { id, ...input }) => deps.sandboxAgents.update(id, input));
  router.handle('agents.sandbox.remove', S['agents.sandbox.remove'], (_e, input) => { deps.sandboxAgents.remove(input.id); });
  router.handle('agents.sandbox.threads', S['agents.sandbox.threads'], () => deps.sandboxAgents.threadAgents());
  router.handle('agents.workspace', S['agents.workspace'], () => deps.sandboxAgents.agentWorkspaceId());
  router.handle('agents.group.list', S['agents.group.list'], () => ({ groups: deps.sandboxAgents.listGroups(), groupThreads: deps.sandboxAgents.groupThreadMap() }));
  router.handle('agents.group.create', S['agents.group.create'], (_e, input) => deps.sandboxAgents.createGroup(input.name, input.agentIds));
  router.handle('agents.group.remove', S['agents.group.remove'], (_e, input) => { deps.sandboxAgents.removeGroup(input.id); });
  router.handle('agents.group.messages', S['agents.group.messages'], (_e, input) => deps.sandboxAgents.groupMessages(input.groupId));
  router.handle('agents.group.send', S['agents.group.send'], (_e, input) => deps.sandboxAgents.sendGroup({
    groupId: input.groupId, text: input.text,
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.agentIds !== undefined ? { agentIds: input.agentIds } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds } : {}),
  }));
  router.handle('threadTiers.get', S['threadTiers.get'], () => deps.tiers.get());
  router.handle('threadTiers.put', S['threadTiers.put'], (_e, i) => deps.tiers.put(i.key, i.pref === null ? undefined : { mode: i.pref.mode, seenUpdatedAt: i.pref.seenUpdatedAt, ...(i.pref.snoozedUntil !== undefined ? { snoozedUntil: i.pref.snoozedUntil } : {}) }));
  router.handle('threadTiers.adopt', S['threadTiers.adopt'], (_e, i) => deps.tiers.adopt(i));
  router.handle('phone.status', S['phone.status'], () => deps.phone.status());
  router.handle('phone.start', S['phone.start'], () => deps.phone.start());
  router.handle('phone.newCode', S['phone.newCode'], () => deps.phone.refreshPairing());
  router.handle('phone.signOut', S['phone.signOut'], () => deps.phone.signOutAll());
  router.handle('phone.stop', S['phone.stop'], () => deps.phone.stop());
  router.handle('sandbox.status', S['sandbox.status'], () => deps.sandboxes.status());
  router.handle('sandbox.pull', S['sandbox.pull'], async () => {
    // Downloads take minutes; start it and let the renderer poll status.
    void deps.sandboxes.pullImage().catch(() => undefined);
    return deps.sandboxes.status();
  });
  router.handle('sandbox.stop', S['sandbox.stop'], (_e, input) => deps.sandboxes.stop(input.agentId));
  router.handle('sandbox.viewer', S['sandbox.viewer'], (_e, input) => {
    const endpoint = deps.sandboxes.endpoint(input.agentId);
    if (endpoint === undefined) throw new Error('This agent’s sandbox isn’t running. It starts when the agent first uses a sandbox tool.');
    openSandboxViewer(endpoint, deps.sandboxAgents.get(input.agentId)?.name);
  });
  router.handle('mcp.cli.overview', S['mcp.cli.overview'], (_e, input) => deps.cliMcp.overview({ sync: input?.sync === true }));
  router.handle('mcp.cli.sync', S['mcp.cli.sync'], () => deps.cliMcp.sync());
  router.handle('mcp.cli.setAutoSync', S['mcp.cli.setAutoSync'], (_e, input) => deps.cliMcp.setAutoSync(input.enabled));
  router.handle('mcp.cli.add', S['mcp.cli.add'], (_e, input) => deps.cliMcp.add({
    name: input.name, endpoint: input.endpoint,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    ...(input.clis !== undefined ? { clis: input.clis } : {}),
  }));
  router.handle('mcp.cli.install', S['mcp.cli.install'], (_e, input) => deps.cliMcp.installExisting(input.key, input.cli));
  router.handle('mcp.cli.remove', S['mcp.cli.remove'], (_e, input) => deps.cliMcp.removeFromCli(input.key, input.cli));
  router.handle('mcp.cli.removeEverywhere', S['mcp.cli.removeEverywhere'], (_e, input) => deps.cliMcp.removeEverywhere(input.key));

  router.handle('remote.list', S['remote.list'], () => deps.remote.list().map(remoteView));
  router.handle('remote.add', S['remote.add'], (_e, input) => remoteView(deps.remote.add(input)));
  router.handle('remote.remove', S['remote.remove'], (_e, input) => { deps.remote.remove(input.id); });
  router.handle('remote.setEnabled', S['remote.setEnabled'], (_e, input) => remoteView(deps.remote.setEnabled(input.id, input.enabled)));
  router.handle('remote.test', S['remote.test'], (_e, input) => deps.remote.test(input.id));

  router.handle('suggestion.list', S['suggestion.list'], () => deps.assistant.listSuggestions().slice(0, 100));
  router.handle('suggestion.confirm', S['suggestion.confirm'], async (_e, input) => {
    const suggestion = deps.assistant.getSuggestion(input.id);
    if (suggestion === undefined) throw new Error('Suggestion not found');
    // "Always do this" records a rule; it still only auto-runs when the
    // orchestrator holds every permission the action needs.
    if (input.always === true) deps.assistant.addAutoExecuteRule({ actionKind: suggestion.action.kind, subject: ORCHESTRATOR_SUBJECT });
    return deps.assistant.confirm(input.id);
  });
  router.handle('suggestion.dismiss', S['suggestion.dismiss'], (_e, input) => deps.assistant.dismiss(input.id));
  router.handle('suggestion.rules', S['suggestion.rules'], () => deps.assistant.listAutoExecuteRules());
  router.handle('suggestion.removeRule', S['suggestion.removeRule'], (_e, input) => {
    deps.assistant.removeAutoExecuteRule({ actionKind: input.actionKind, subject: ORCHESTRATOR_SUBJECT });
  });

  router.handle('learning.proposals', S['learning.proposals'], () => deps.learning.listProposals().slice(0, 100));
  router.handle('learning.approve', S['learning.approve'], (_e, input) => deps.learning.approve(input.id));
  router.handle('learning.reject', S['learning.reject'], (_e, input) => deps.learning.reject(input.id));
  router.handle('learning.stats', S['learning.stats'], () => deps.learningLoop.agentStats());
  router.handle('learning.status', S['learning.status'], () => {
    if (deps.learningCron === undefined) throw new Error('Learning cron is not configured');
    return deps.learningCron.getStatus();
  });
  router.handle('learning.setConfig', S['learning.setConfig'], (_e, input) => {
    if (deps.learningCron === undefined) throw new Error('Learning cron is not configured');
    return deps.learningCron.setConfig(input);
  });
  router.handle('learning.runNow', S['learning.runNow'], () => {
    if (deps.learningCron === undefined) throw new Error('Learning cron is not configured');
    return deps.learningCron.runNow('manual');
  });
  router.handle('learning.purgeRoutingApprovals', S['learning.purgeRoutingApprovals'], () => deps.learning.purgeRoutingApprovals());
}
