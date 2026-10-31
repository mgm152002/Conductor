import { AttachmentService } from './attachments/attachment-service';
import { registerAttachmentHandlers } from './ipc/register-attachments';
import { join } from 'node:path';
import { app, ipcMain, shell } from 'electron';
import { SqliteStore } from './db/store';
import { WorkspaceService } from './domain/workspace-service';
import { SettingsService } from './domain/settings-service';
import { AuditLog } from './domain/audit-log';
import { PermissionService } from './domain/permission-service';
import { DataControlService } from './domain/data-control-service';
import { Registry } from './registry/registry';
import { TaskStateMachine } from './orchestrator/state-machine';
import { TaskCanceller } from './orchestrator/cancellation';
import { Orchestrator } from './orchestrator/orchestrator';
import { ResumeCenter } from './orchestrator/resume-center';
import { ResumeService } from './orchestrator/resume-service';
import { IpcRouter } from './ipc/router';
import { registerDomainHandlers } from './ipc/register-domain';
import { IpcTaskEventEmitter } from './ipc/task-event-emitter';
import { IpcExternalFlowEmitter } from './ipc/external-flow-emitter';
import { DiskManagedStorage } from './storage/managed-storage';
import { CliCatalog } from './catalog/cli-catalog';
import { CliRegistrar } from './catalog/registrar';
import { ConnectorService } from './connectors/connector-service';
import { IngestionWorker } from './connectors/ingestion-worker';
import { resumeTargetFor, threadHistory } from './orchestrator/thread-context';
import type { Task } from '@shared/domain';
import { FilesConnectorLifecycle } from './connectors/files-connector';
import { createMemoryIngestionSink } from './connectors/memory-ingestion-sink';
import { ConnectorRuntime } from './connectors/connector-runtime';
import { IpcConnectorEventEmitter, registerConnectorHandlers } from './ipc/register-connectors';
import { ContextEngine } from './domain/context-engine';
import { MemoryEngine } from './domain/memory-engine';
import { Mem0Client } from './domain/mem0-client';
import { SkillsService } from './domain/skills-service';
import { SkillTriggerService } from './domain/skill-trigger-service';
import { SkillAuthoringService } from './domain/skill-authoring-service';
import { extractInvoice } from './domain/invoice-extractor';
import { matchPurchaseOrder } from './domain/purchase-order-matcher';
import { SkillOrchestrationService } from './orchestrator/skill-orchestration';
import { WorkflowEngine } from './orchestrator/workflow-engine';
import { PersistentContextProvider } from './orchestrator/persistent-context-provider';
import { TaskRunner } from './orchestrator/task-runner';
import { TaskQueries } from './orchestrator/task-queries';
import { evidenceEvaluator } from './orchestrator/evidence-evaluator';
import { registerKnowledgeHandlers } from './ipc/register-knowledge';
import { GitHubService } from './domain/github-service';
import { registerGitHubHandlers } from './ipc/register-github';
import { registerAutomationHandlers } from './ipc/register-automation';
import { SelfLearningEngine } from './domain/self-learning-service';
import { LearningLoop } from './domain/learning-loop';
import { ProactiveAssistant } from './domain/proactive-assistant-service';
import { ProactiveSignals, connectorSources, suggestionExecutor } from './domain/proactive-signals';
import { SecretStore, ownershipGate } from './secrets/secret-store';
import { SecretsProxy } from './secrets/secrets-proxy';
import { KeychainSecretResolver } from './secrets/keychain-resolver';
import { NetworkAccess, type ConsentGate } from './connectors/network-access';
import { EmailConnectorLifecycle } from './connectors/email-connector';
import { CalendarConnectorLifecycle } from './connectors/calendar-connector';
import { SlackConnectorLifecycle } from './connectors/slack-connector';
import { McpRegistry } from './mcp/mcp-registry';
import { SdkMcpTransport } from './mcp/sdk-transport';
import { McpService } from './mcp/mcp-service';
import { RemoteHostService } from './adapters/remote-hosts';
import { IpcSuggestionEmitter, registerIntegrationHandlers } from './ipc/register-integrations';
import { ToolApprovalBroker } from './orchestrator/tool-approvals';
import { AgentQuestionBroker } from './orchestrator/agent-questions';
import { ensureWorktree } from './domain/worktree';
import { AgentPlanner } from './plan/agent-planner';
import { ModelCatalogService } from './agents/model-catalog';
import { RunResolver } from './agents/run-resolver';
import { assessDifficulty, economyGuidance } from './agents/model-routing';
import { CONTEXT_BUDGET, capContext } from './agents/context-budget';
import { UsageRecorder, usageSummary } from './usage/usage';
import { QuotaRecorder } from './usage/quota';
import { QuotaPollingService } from './usage/quota-polling';
import { deleteProject } from './domain/project-deletion';
import { deleteThread } from './domain/thread-deletion';
import { ChatService } from './domain/chat-service';
import { AgentTitleGenerator, ThreadTitleService, TITLE_TIMEOUT_MS } from './domain/thread-title-service';
import { AgentPrDescriptionGenerator } from './domain/pr-description';
import { defaultModelKey } from '@shared/model-defaults';
import { IpcChatEventEmitter, registerChatHandlers } from './ipc/register-chat';
import { AgentLearningAnalyzer } from './domain/learning-analyzer';
import { LearningCronService } from './domain/learning-cron';

// Main-process composition root. Opens the store, runs migrations, constructs
// the domain services, and registers the validated IPC handlers. Later
// milestones extend this with the registry, orchestrator, resume center, and
// a real SQLite-backed audit sink.

export interface AppServices {
  chat: ChatService;
  chatEvents: IpcChatEventEmitter;
  store: SqliteStore;
  workspaces: WorkspaceService;
  settings: SettingsService;
  audit: AuditLog;
  permissions: PermissionService;
  registry: Registry;
  orchestrator: Orchestrator;
  resumeCenter: ResumeCenter;
  resumeService: ResumeService;
  cliCatalog: CliCatalog;
  connectors: ConnectorService;
  ingestionWorker: IngestionWorker;
  /** Live connector scheduling, file watching and sync coordination. */
  connectorRuntime: ConnectorRuntime;
  /** The renderer emitter connector state changes are surfaced through. */
  connectorEvents: IpcConnectorEventEmitter;
  selfLearning: SelfLearningEngine;
  learningLoop: LearningLoop;
  learningCron: LearningCronService;
  mcp: McpService;
  remoteHosts: RemoteHostService;
  secrets: SecretStore;
  /** The renderer emitter proactive suggestions are surfaced through. */
  suggestionEvents: IpcSuggestionEmitter;
  dataControl: DataControlService;
  /** Background and on-demand provider quota snapshot refreshes. */
  quotaPolling: QuotaPollingService;
  router: IpcRouter;
  /** The renderer event emitter the orchestrator streams task progress through. */
  taskEvents: IpcTaskEventEmitter;
  /** The renderer emitter the external-flow indicator is surfaced through. */
  externalFlowEvents: IpcExternalFlowEmitter;
}

function resolveDbPath(): string {
  // userData is created lazily by Electron; fall back to cwd in non-Electron
  // contexts (not expected in production).
  const base = app.getPath('userData');
  return join(base, 'conductor.db');
}

export async function bootstrap(): Promise<AppServices> {
  const store = new SqliteStore(resolveDbPath());
  await store.migrate();

  // AuditLog is the durable, immutable audit sink the IPC router and the
  // permission service both append through.
  const audit = new AuditLog(store);
  const workspaces = new WorkspaceService(store);
  const settings = new SettingsService(store, workspaces);
  // The user's global "auto-approve everything" toggle, read on every tool call
  // so switching it on also affects sessions that are already running.
  const autoApprove = (): boolean => settings.resolve('execution.autoApprove') === true;
  const permissions = new PermissionService(store, audit);

  // Orchestrator core: the durable state machine, the canceller (which drives
  // in-flight adapter sessions through the registry), and the lifecycle layer
  // that createTask / beginExecution / listActive / cancelTask run through.
  const registry = new Registry();
  const stateMachine = new TaskStateMachine(store, audit);
  const canceller = new TaskCanceller(store, stateMachine, registry, audit);

  // The IPC router doubles as the transport for the renderer event emitter the
  // orchestrator streams RUNNING execution through (task.updated/task.stream).
  const router = new IpcRouter({ ipcMain, audit });
  const taskEvents = new IpcTaskEventEmitter(router);
  const externalFlowEvents = new IpcExternalFlowEmitter(router);
  const chatEvents = new IpcChatEventEmitter(router);

  const dataControl = new DataControlService(store, settings, audit, externalFlowEvents);
  const context = new ContextEngine(store);
  const memory = new MemoryEngine(store, Date.now, new Mem0Client({ connectionFile: join(app.getPath('userData'), 'mem0-connection.json') }));
  const persistentContext = new PersistentContextProvider(store, Date.now, memory);
  // Do not prevent relational/workflow startup during a Mem0 outage. Every
  // explicit memory operation retries this durable queue and reports failures.
  const stopMemorySync = memory.startBackgroundSync((error: unknown) => console.warn('Mem0 synchronization pending:', error instanceof Error ? error.message : 'unavailable'));
  app.once('before-quit', stopMemorySync);
  const skills = new SkillsService(store, audit);
  // Learned vendor skills: recognition resolves active bindings, authoring
  // captures a validated draft after a completed task, and orchestration wires
  // both into every agent step.
  const skillTriggers = new SkillTriggerService(skills);
  const skillAuthoring = new SkillAuthoringService(store, skills, audit);
  const skillOrchestration = new SkillOrchestrationService({
    store, skills, trigger: skillTriggers, authoring: skillAuthoring, audit,
    extract: extractInvoice, match: matchPurchaseOrder,
    emitter: taskEvents,
  });
  const workflows = new WorkflowEngine(store);

  // Consent gate shared by every outbound integration (connectors, SSH hosts):
  // a provider the user has not allowed is blocked before any I/O.
  const consentGate: ConsentGate = {
    require: (provider, target) => {
      const decision = dataControl.beginExternalFlow({ provider, target });
      if (decision.status === 'blocked') throw new Error(decision.message);
    },
  };
  const grantConsentOnce = (provider: string): void => {
    if (!dataControl.hasConsent(provider)) dataControl.grantConsent(provider);
  };

  // Secrets: values in the macOS Keychain, metadata in SQLite. The proxy only
  // substitutes a secret into a request made by the integration that owns it.
  const secretStore = new SecretStore(store, audit);
  const secretsProxy = new SecretsProxy(new KeychainSecretResolver(), ownershipGate(secretStore), audit);
  const network = new NetworkAccess(secretsProxy, consentGate);

  // Self-learning: outcomes of finished tasks feed routing proposals that the
  // user approves; approved rules steer routing and roll back on regression.
  const selfLearning = new SelfLearningEngine(store, audit);
  const learningLoop = new LearningLoop(store, selfLearning);
  // Learning cron: every 5 minutes the user-approved LLM reviews success
  // rates + logs and proposes routing (auto-approved only in auto mode).
  const learningCron = new LearningCronService({
    settings, audit, learningLoop, engine: selfLearning,
    analyzer: new AgentLearningAnalyzer(registry, join(app.getPath('userData'), 'learning-sandbox')),
    availableAgents: () => registry.listAdapters().filter((a) => a.available).map((a) => a.id),
  });

  // MCP: servers are added untrusted/disabled; approval enables them, lists
  // their tools, and makes them available to Codex runs (non read-only mode).
  const mcpTransport = new SdkMcpTransport();
  const mcpRegistry = new McpRegistry(store, audit, {
    transport: mcpTransport,
    accessControl: ({ caller }) => caller === 'user' || permissions.allows({ type: 'agent', id: 'orchestrator' }, { kind: 'external_comm' }),
  });
  const mcp = new McpService(mcpRegistry, mcpTransport);

  // Managed_Local_Storage for artifacts persisted during step execution lives
  // beside the DB under userData.
  const storage = new DiskManagedStorage(join(app.getPath('userData'), 'blobs'));
  const attachments = new AttachmentService(store, storage);
  registerAttachmentHandlers(router, attachments);

  // Follow-ups: earlier turns as reference data, and the provider session to
  // resume when the step is pinned to the agent that ran the previous turn.
  const threadInput = (task: Task, capability: string): Record<string, unknown> => {
    const conversation = threadHistory(store, task);
    const resume = resumeTargetFor(store, task, capability);
    return {
      ...(conversation.length > 0 ? { conversation } : {}),
      ...(resume !== undefined ? { resume } : {}),
    };
  };

  // The input every agent step starts from: workspace root, permission mode,
  // project context, thread history, MCP servers and model overrides.
  // Model and effort per run: composer choice, then Settings, then Auto by
  // how demanding the request is (cheap models for quick requests).
  const modelCatalogs = new ModelCatalogService(registry);
  const runResolver = new RunResolver(store, settings, modelCatalogs);

  // Casual chat: project-free conversation that recalls personal-layer memory
  // for context and resolves its model/effort from the composer, Settings or
  // Auto. It shares the one memory engine and model-catalog instances so a
  // Mem0 health check and the chat picker reflect the same services.
  // Auto thread titles: a fast economy-model call names each new thread from
  // its first message, replacing the first-characters placeholder in the
  // background. Shared by Work threads, casual chats, and PR creation.
  const titleGenerator = new AgentTitleGenerator(registry, join(app.getPath('userData'), 'title-sandbox'), modelCatalogs, TITLE_TIMEOUT_MS, {
    // Pin the same Settings default model the user's chats run on; a bare
    // session would otherwise start on the CLI's own (possibly broken) default.
    settingsRunChoice: (agentId) => {
      const read = (key: string): string | undefined => {
        const value = settings.resolve(key);
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
      };
      const model = read(defaultModelKey(agentId));
      const effort = read(`agents.${agentId}.effort`);
      return model === undefined && effort === undefined ? undefined : {
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      };
    },
    // Same-agent fallback model before the next CLI, mirroring run fallback.
    fallbackModel: (agentId) => runResolver.fallbackModel(agentId),
    onError: (message) => { console.warn(message); },
  });
  const threadTitles = new ThreadTitleService({
    store,
    getTask: (taskId) => stateMachine.getTask(taskId),
    onTaskUpdated: (task) => { taskEvents.emit('task.updated', task); },
    generate: (objective) => titleGenerator.generate(objective),
  });

  const chat = new ChatService(
    store, registry, join(app.getPath('userData'), 'chat-sandbox'),
    (snapshot) => chatEvents.emit(snapshot),
    {
      memory, catalogs: modelCatalogs, settings, attachments,
      generateTitle: (firstMessage) => threadTitles.generateTitle(firstMessage),
    },
  );
  registerChatHandlers(router, chat);
  // Personal chats created before auto-titles (or whose title call failed)
  // still show the first-message placeholder; name the recent ones now.
  void chat.backfillTitles(10).catch(() => undefined);

  // One worktree per thread, created before the agent's first step runs.
  // Follow-ups in the thread reuse it; non-Git projects run in place.
  const worktrees = new Map<string, Promise<string>>();
  const threadRoot = (task: Task): Promise<string> => {
    const root = workspaces.get(task.workspaceId)!.rootPath;
    const key = task.threadId ?? task.id;
    const cached = worktrees.get(key);
    if (cached !== undefined) return cached;
    const pending = ensureWorktree(root, key).then((info) => info.path).catch(() => root);
    worktrees.set(key, pending);
    return pending;
  };

  const executionInput = async (task: Task, step: { description: string; requiredCapability: string }): Promise<Record<string, unknown>> => {
    const mode = permissions.grantsFor({type:'agent',id:'orchestrator'})[0]?.profile ?? 'read_only';
    const difficulty = assessDifficulty(task.objective);
    const targetAgent = step.requiredCapability.startsWith('objective.fulfill.')
      ? step.requiredCapability.slice('objective.fulfill.'.length) : undefined;
    const resolved = runResolver.resolve(task, {
      role: 'main', difficulty,
      ...(targetAgent !== undefined ? { agents: [targetAgent] } : {}),
    });
    const guidance = economyGuidance(difficulty);
    // Learned skills are resolved for every planned step. A match attaches its
    // untrusted reference data; no match adds first-time authoring guidance.
    // Usage is recorded when the step actually starts, not while planning.
    const prepared = skillOrchestration.prepareStep({
      task, step, recordUsage: false, ...(guidance ? { guidance } : {}),
    });
    return {objective:task.objective,description:step.description,acceptanceCriteria:task.acceptanceCriteria,
      rootPath: await threadRoot(task),
      mode,
      attachments: await runner.executionAttachments(task),
      ...threadInput(task, step.requiredCapability),
      // Approved MCP servers can act outside the agent's sandbox, so they
      // are only handed to agents when the profile allows execution.
      ...(mode !== 'read_only' ? { mcpServers: mcp.forAgents() } : {}),
      ...(resolved.models ? { models: resolved.models } : {}),
      ...(resolved.efforts ? { efforts: resolved.efforts } : {}),
      runs: resolved.runs,
      difficulty,
      ...(prepared.contextData.length > 0 ? { contextData: prepared.contextData } : {}),
      ...(prepared.guidance ? { guidance: prepared.guidance } : {}),
    };
  };

  // Token usage per agent session, and the agent display names it is shown with.
  const usage = new UsageRecorder(store);
  const quota = new QuotaRecorder(store);
  const quotaPolling = new QuotaPollingService({ quota });
  const agentName = (id: string): string => (registry.has(id) ? registry.resolve(id).record.name : id);

  // Plan mode: a chosen agent writes requirements and a task list; each task
  // runs on its agent and independent tasks run in parallel.
  const planner = new AgentPlanner({
    store, registry, usage, quota, emitter: taskEvents, agentName,
    getTask: (id) => stateMachine.getTask(id),
    baseInput: async (task, requiredCapability) => ({
      ...await executionInput(task, { description: 'Write the plan', requiredCapability }),
      contextData: capContext(await persistentContext.resolveContent({ workspaceId: task.workspaceId, taskId: task.id }, task.contextRefs), CONTEXT_BUDGET[assessDifficulty(task.objective)]),
    }),
    // A plan task's own choice replaces the planner's for its agent.
    resolveRun: (task, _agentId, difficulty) => {
      const r = runResolver.resolve(task, { role: 'subagent', difficulty });
      return { models: r.models ?? {}, efforts: r.efforts ?? {}, runs: r.runs };
    },
    warm: (ids) => modelCatalogs.warm(ids),
  });

  const orchestrator = new Orchestrator(
    store,
    stateMachine,
    workspaces,
    canceller,
    audit,
    {
      registry, permissions, emitter: taskEvents, storage, planner, usage, quota,
      contextProvider: persistentContext,
      criterionEvaluator: evidenceEvaluator(store),
      // CLI agents can have side effects; retries are explicit through the UI.
      maxStepRetries: 0,
      historicalPerformance: (adapterId, capabilityId) => learningLoop.routingScore(adapterId, capabilityId),
      fallbackModel: (id) => runResolver.fallbackModel(id),
      executionInput,
      resolveInput: async (step, base) => {
        const task = stateMachine.getTask(step.taskId);
        if (!task) throw new Error('Task no longer exists');
        const persistent = capContext(await persistentContext.resolveContent({ workspaceId: task.workspaceId, taskId: task.id }, task.contextRefs), CONTEXT_BUDGET[assessDifficulty(task.objective)]);
        // Re-resolve immediately before the adapter starts so a skill edited
        // between planning and execution is applied at its current version.
        // Persistent context is included so invoice text or a purchase order
        // carried as a context item participates in recognition and matching.
        const prepared = skillOrchestration.prepareStep({
          task, step,
          contextData: [
            ...(Array.isArray(base['contextData']) ? base['contextData'] as unknown[] : []),
            ...persistent,
          ],
          ...(typeof base['guidance'] === 'string' ? { guidance: base['guidance'] } : {}),
        });
        return {
          ...base,
          contextData: prepared.contextData,
          ...(prepared.guidance ? { guidance: prepared.guidance } : {}),
        };
      },
      onStepSettled: (taskId) => {
        planner.refresh(taskId);
        const task = stateMachine.getTask(taskId);
        if (task !== undefined) taskEvents.emit('task.updated', task);
      },
    },
  );

  // PR bodies are written by an agent from the finished change (commits,
  // files, diff) via the same pinned economy-model call as thread titles.
  const prDescriptions = new AgentPrDescriptionGenerator(
    (prompt, description) => titleGenerator.generateText(prompt, description),
  );

  // GitHub integration: per-project token (Keychain), auto-PR on completion.
  const github = new GitHubService({
    store, workspaces, secrets: secretStore,
    resolveSecret: (secretId) => new KeychainSecretResolver().resolve(secretId),
    getTask: (taskId) => stateMachine.getTask(taskId),
    onTaskUpdated: (task) => { taskEvents.emit('task.updated', task); },
    ensureThreadTitle: (task) => threadTitles.ensure(task),
    generatePrDescription: (context) => prDescriptions.generate(context),
    openExternal: (url) => shell.openExternal(url),
  });

  // Task continuity / Resume Center: boot reconciliation (task 11.1). It shares
  // the store, state machine, registry, and audit log so every state change
  // still goes through the write-ahead transition primitive. onBoot reconciles
  // every non-terminal task against real session liveness and filesystem drift,
  // classifying each as RESUMABLE / RECOVERABLE_INTERRUPTION / BLOCKED.
  const resumeCenter = new ResumeCenter(store, stateMachine, registry, audit, {
    storage,
  });

  // The Resume Center action handler (task 11.2): carries out
  // resume/inspect/restart/discard behind `resume.act`. It drives execution
  // through the orchestrator and the canceller so every state change still
  // goes through the write-ahead primitive, and streams task.updated to the
  // renderer through the same emitter the orchestrator uses.
  const resumeService = new ResumeService(
    store,
    stateMachine,
    orchestrator,
    canceller,
    audit,
    { emitter: taskEvents },
  );

  // Agent CLI Catalog: the façade over PATH discovery, status derivation, the
  // registrar, and the confirmation-gated install service. The registrar syncs
  // the shared Registry so an installed CLI is surfaced as a LocalCliAdapter;
  // discovery and the command runner default to the real implementations.
  // Per-tool-call approvals: in Assisted execution every agent CLI asks
  // Conductor before each command / file change (Codex over app-server,
  // Claude Code via its permission prompt tool, OpenCode and Kiro over ACP,
  // Antigravity via a PreToolUse hook).
  const toolApprovals = new ToolApprovalBroker(store, permissions, (taskId) => {
    taskEvents.emit('task.updated', orchestrator.getTask(taskId));
  });
  // Agent questions (Codex requestUserInput, MCP elicitation, ACP question
  // tools) park here until the user answers in the thread.
  const agentQuestions = new AgentQuestionBroker((request) => {
    taskEvents.emit('question.requested', request);
  });
  const cliCatalog = new CliCatalog({ registrar: new CliRegistrar(registry, undefined, (provider) => {
    const decision = dataControl.beginExternalFlow({provider,target:'Agent CLI provider'});
    if (decision.status === 'blocked') throw new Error(decision.message);
  }, (request, signal) => toolApprovals.request(request, signal), autoApprove, (prompt, signal) => agentQuestions.ask(prompt, signal)) });
  // Proactive assistant: suggestions from stuck tasks, repeated failures, new
  // email questions and upcoming events. Suggest-only unless an auto-run rule
  // exists and permissions allow; external side effects always wait.
  const suggestionEvents = new IpcSuggestionEmitter(router);
  // Assigned after the assistant is constructed; callbacks read it later.
  // eslint-disable-next-line prefer-const
  let runnerRef: TaskRunner | undefined;
  const assistant = new ProactiveAssistant(store, audit, permissions, connectorSources(store), suggestionEvents, suggestionExecutor({
    retryTask: async (taskId) => { runnerRef?.drive(taskId); },
    resumeTask: async (taskId) => {
      const result = await resumeService.act({ taskId, action: 'resume' });
      if (result.status === 'confirmation_required') throw new Error('Open the thread to confirm resuming this task.');
    },
    createTask: async (input) => { await runnerRef?.create(input); },
  }));
  const signals = new ProactiveSignals(store, assistant, () => workspaces.activeWorkspaceId());

  const runner = new TaskRunner({attachments,store,orchestrator,stateMachine,permissions,registry,audit,emitter:taskEvents,toolApprovals,planMode:planner,
    runOptions: runResolver, warmModels: (ids) => modelCatalogs.warm(ids),
    onThreadCreated: (task) => { threadTitles.schedule(task); },
    onFinished: (task) => {
      // Title generation at creation competes with the just-started work
      // agent and can lose to a quota/free-limit failure; retry once the
      // thread settles (still only fills an empty title) instead of leaving
      // the placeholder until the next app launch's backfill.
      const root = stateMachine.getTask(task.threadId ?? task.id);
      if (root !== undefined) threadTitles.schedule(root);
      // Finalize skill usage with the real outcome before learning, then let
      // authoring capture a validated first-time draft from the final response.
      skillOrchestration.onTaskFinished(task);
      learningLoop.onTaskFinished(task);
      void signals.onTaskFinished(task);
      // File a PR for the finished thread when the project opted in.
      void github.autoPrForCompletedTask(task);
    },
    onStuck: (task) => {
      const root = stateMachine.getTask(task.threadId ?? task.id);
      if (root !== undefined) threadTitles.schedule(root);
      void signals.onTaskStuck(task);
    },
  });
  runnerRef = runner;
  // Threads created before auto-titles (or whose generation failed) get named
  // too: backfill the most recent untitled roots, queued one at a time.
  threadTitles.scheduleRecent(10);

  // Remote hosts: Codex over SSH. Each run checks consent for the host and for
  // the Codex provider.
  const remoteHosts = new RemoteHostService(store, audit, registry, (host) => {
    consentGate.require(RemoteHostService.provider(host.host), host.host);
    consentGate.require('codex', 'Agent CLI provider');
  }, grantConsentOnce);
  const taskQueries = new TaskQueries(store,orchestrator,permissions,storage,(taskId) => planner.view(taskId),attachments);

  // M5 connector framework + ingestion worker (Requirement 14). The service
  // owns durable connector lifecycle state and the ingested-item/proposal
  // repositories; the worker drives a connector's lifecycle and wraps every
  // retrieved payload on the data channel as untrusted data. Concrete
  // per-kind connector lifecycles register their implementations here as they
  // land; the worker stays source-agnostic.
  const connectors = new ConnectorService(store, audit);
  const ingestionWorker = new IngestionWorker({
    connectors,
    audit,
    // Local folders are the connector kind with a real implementation. Email,
    // messaging and calendar need provider OAuth flows that are not built, so
    // they are surfaced as unsupported rather than faked.
    lifecycles: {
      files: new FilesConnectorLifecycle(),
      email: new EmailConnectorLifecycle(network),
      calendar: new CalendarConnectorLifecycle(network),
      messaging: new SlackConnectorLifecycle(network),
    },
    // Ingested content is persisted as untrusted Mem0 memories.
    sink: createMemoryIngestionSink(memory),
    retryDelayMs: 1_000,
  });
  const connectorEvents = new IpcConnectorEventEmitter(router);
  const connectorRuntime = new ConnectorRuntime({
    connectors,
    worker: ingestionWorker,
    flushMemories: () => memory.synchronize(),
    syncEnabled: () => dataControl.getSettings().syncEnabled,
    workspaceExists: (id) => workspaces.get(id) !== undefined,
    emit: (event) => { connectorEvents.emit(event); },
    secrets: secretStore,
    grantConsent: grantConsentOnce,
    onSynced: (connector, outcome) => { void signals.onConnectorSynced(connector, outcome); },
  });

  // M8 self-learning engine (Requirement 18). Observes per-task outcomes and
  // runs the improvement cycle — evaluate against comparable prior examples,
  // propose demonstrated improvements for approval, and roll back adopted
  // improvements that regress. It only ever writes learned artifacts (skills /
  // routing rules / memory / workflow versions), never core executable code
  // (Property 10), so it shares the store and the immutable audit log.

  // Cross-cutting external-flow transparency & data control (Requirement 21).
  // Conductor is local-first: the service gates every external transmission on
  // explicit per-provider consent, fires the external-flow indicator to the
  // renderer within 500 ms when a flow is permitted, exposes the
  // user-configurable retention/indexing/sync settings, and performs
  // stored-data deletion with a completion confirmation. It shares the store,
  // settings, and immutable audit log, and surfaces the indicator through the
  // same IPC router the task emitter uses.


  registerDomainHandlers({
    router, runner, taskQueries, permissions, registry, audit, store,
    workspaces,
    settings,
    orchestrator,
    resumeCenter,
    resumeService,
    cliCatalog,
    dataControl,
    questions: agentQuestions,
    flushMemories: () => memory.synchronize(),
    deleteProject: (workspaceId) => deleteProject({ store, storage, attachments, audit, flushMemories: () => memory.synchronize(), deleteConnector: (id) => connectorRuntime.delete(id) }, workspaceId),
    deleteThread: (threadId) => deleteThread({ store, storage, attachments, audit, flushMemories: () => memory.synchronize() }, threadId),
    refreshUsageLimits: () => quotaPolling.refresh(),
    usageSummary: (input) => usageSummary(store, input, agentName, { adapters: registry.listAdapters() }),
  });

  registerGitHubHandlers(router, github);
  registerKnowledgeHandlers({router,store,context,memory});
  registerConnectorHandlers({router,runtime:connectorRuntime});
  registerIntegrationHandlers({router,registry,secrets:secretStore,mcp,remote:remoteHosts,assistant,learning:selfLearning,learningLoop,learningCron,modelCatalogs});
  registerAutomationHandlers({router,store,workflows,skills,
    startWorkflow: async (input) => {
      const workflow = workflows.get(input.workflowId,input.version);
      if (input.variables && Object.keys(input.variables).length) throw new Error('Workflow variables are not supported by task execution yet.');
      return runner.startWorkflow(workflow,input.workspaceId);
    },
    testWorkflow: async (input) => {
      const workflow = workflows.get(input.workflowId,input.version);
      if (!workspaces.get(input.workspaceId)) throw new Error('Workspace not found');
      const missing = workflow.steps.filter((step) => !registry.adaptersSupporting(step.requiredCapability).some((a) => a.available));
      return {workflowId:workflow.workflowId,version:workflow.version,durationMs:0,results:[
        {criterionId:'configuration',outcome:missing.length ? 'fail' as const:'pass' as const,
          detail:missing.length ? `No available adapter for: ${missing.map((s)=>s.requiredCapability).join(', ')}` : 'Graph is valid and all capabilities are available. This validates configuration; it does not execute steps.'},
        ...workflow.validationCriteria.map((criterion) => ({criterionId:criterion.id,outcome:'fail' as const,detail:'Requires a workflow run and recorded verification evidence.'})),
      ]};
    },
  });

  // Deterministic crash recovery on every launch: reconcile non-terminal tasks
  // before the renderer drives any new work (the Resume Center UI + snapshot
  // IPC land in task 11.2).
  cliCatalog.rescan();
  await resumeCenter.onBoot();

  // Initial PATH scan so installed CLIs are discovered and registered at
  // startup (Requirement 2.5, 3.1). Runs after boot reconciliation so the
  // Registry is ready before any adapter is registered.
  cliCatalog.rescan();
  remoteHosts.registerAll();
  // Load each installed agent's model list in the background so Auto routing
  // and the composer's pickers have it before the first message.
  void modelCatalogs.warm(registry.listAdapters().map((a) => a.id)).catch(() => undefined);

  return {
    chat,
    chatEvents,
    store,
    workspaces,
    settings,
    audit,
    permissions,
    registry,
    orchestrator,
    resumeCenter,
    resumeService,
    cliCatalog,
    connectors,
    ingestionWorker,
    connectorRuntime,
    connectorEvents,
    selfLearning,
    learningLoop,
    learningCron,
    mcp,
    remoteHosts,
    secrets: secretStore,
    suggestionEvents,
    dataControl,
    quotaPolling,
    router,
    taskEvents,
    externalFlowEvents,
  };
}
