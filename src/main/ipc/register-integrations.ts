import type { WebContents } from 'electron';
import type { Suggestion } from '@shared/domain';
import { compareAgentPreference } from '@shared/agent-preference';
import { INTEGRATION_SCHEMAS, type RemoteHostView } from '@shared/integrations-contract';
import type { Registry } from '../registry/registry';
import type { SecretStore } from '../secrets/secret-store';
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
