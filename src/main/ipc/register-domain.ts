import { APPLICATION_SCHEMAS as A } from '@shared/application-contract';
import { ApprovalResolveRequest, RegistryListAdaptersRequest } from '@shared/ipc-contract';
import type { TaskRunner } from '../orchestrator/task-runner';
import type { TaskQueries } from '../orchestrator/task-queries';
import type { PermissionService } from '../domain/permission-service';
import type { Registry } from '../registry/registry';
import type { AuditLog } from '../domain/audit-log';
import type { Store } from '../db/types';
import {
  CliCatalogInstallCommandRequest,
  CliCatalogInstallRequest,
  CliCatalogListRequest,
  CliCatalogRescanRequest,
  DataControlDeleteRequest,
  DataControlGetSettingsRequest,
  DataControlGrantConsentRequest,
  DataControlListConsentsRequest,
  DataControlRevokeConsentRequest,
  DataControlSetSettingsRequest,
  ResumeActRequest,
  ResumeSnapshotRequest,
  SettingsGetRequest,
  SettingsSetRequest,
  TaskCancelRequest,
  TaskCreateRequest,
  TaskGetRequest,
  TaskListActiveRequest,
  ThreadDeleteRequest,
  ThreadRenameRequest,
  WorkspaceCreateRequest,
  WorkspaceListRequest,
  WorkspaceSelectRequest,
} from '@shared/ipc-contract';
import type {
  DataControlSettings,
  DataDeletionResult,
  ExternalFlowConsent,
  ResumeActResult,
  ResumeSnapshot,
  Task,
  Workspace,
} from '@shared/domain';
import type { CatalogEntryView, InstallOutcome } from '@shared/catalog';
import type { IpcRouter } from './router';
import type { SettingsService } from '../domain/settings-service';
import { NO_VALUE } from '../domain/settings-service';
import type { WorkspaceService } from '../domain/workspace-service';
import type { Orchestrator } from '../orchestrator/orchestrator';
import type { ResumeCenter } from '../orchestrator/resume-center';
import type { ResumeService } from '../orchestrator/resume-service';
import type { CliCatalog } from '../catalog/cli-catalog';
import type { DataControlService } from '../domain/data-control-service';
import type { ProjectDeletionResult } from '../domain/project-deletion';
import type { ThreadDeletionResult } from '../domain/thread-deletion';
import { renameThread } from '../domain/thread-rename';
import { Mem0Error } from '../domain/mem0-client';
import { parseRunOptions } from '../agents/run-resolver';
import type { UsageRange, UsageSummary } from '@shared/usage';
import { UsageSummaryRequest, WorkspaceDeleteRequest } from '@shared/ipc-contract';
import { listWorkspaceChanges, readWorkspaceFileDiff } from '../domain/workspace-changes';
import { worktreeBranch, worktreePathFor } from '../domain/worktree';
import { existsSync } from 'node:fs';
import type { AgentQuestionBroker } from '../orchestrator/agent-questions';

// Wire the workspace, settings, and task-lifecycle services onto the validated
// IPC router. Every handler goes through `router.handle`, which enforces the
// allowlist and validates payloads with the channel's Zod schema before
// running.

/**
 * Validated query for the usage overview. `range` mirrors the shared
 * `UsageRange` union; `UsageSummaryRequest` rejects any other value before the
 * handler or dependency runs.
 */
export interface UsageSummaryQuery {
  range: UsageRange;
  workspaceId?: string;
  /** Only an explicit refresh asks the main process to probe CLIs. */
  refreshLimits?: boolean;
}

export interface DomainHandlerDeps {
  router: IpcRouter;
  runner: TaskRunner;
  taskQueries: TaskQueries;
  permissions: PermissionService;
  registry: Registry;
  audit: AuditLog;
  store: Store;
  workspaces: WorkspaceService;
  settings: SettingsService;
  orchestrator: Orchestrator;
  resumeCenter: ResumeCenter;
  resumeService: ResumeService;
  cliCatalog: CliCatalog;
  dataControl: DataControlService;
  /** Pending agent questions awaiting human review. */
  questions?: AgentQuestionBroker;
  flushMemories?: () => Promise<void>;
  /** Deletes a project and everything stored for it. */
  deleteProject?: (workspaceId: string) => Promise<ProjectDeletionResult>;
  /** Deletes a conversation thread and everything stored for its tasks. */
  deleteThread?: (threadId: string) => Promise<ThreadDeletionResult>;
  /**
   * Token usage overview. The extended summary keeps the legacy totals and
   * breakdowns and adds `clients`: every attached CLI, including zero-usage
   * ones, with its session, daily, and weekly limit windows under `limits`.
   */
  usageSummary?: (input: UsageSummaryQuery) => UsageSummary;
  /** Refresh provider quota snapshots before serving an explicit usage read. */
  refreshUsageLimits?: () => Promise<void>;
}

export function registerDomainHandlers(deps: DomainHandlerDeps): void {
  const {
    router,
    workspaces,
    settings,
    orchestrator,
    resumeCenter,
    resumeService,
    cliCatalog,
    dataControl,
  } = deps;

  const resumeInFlight = new Set<string>();
  router.handle('workspace.active', A['workspace.active'], () => workspaces.activeWorkspaceId() ?? null);
  router.handle('task.list', A['task.list'], (_e, i) => deps.taskQueries.list(i ? {...(i.workspaceId ? {workspaceId:i.workspaceId}:{}),...(i.limit ? {limit:i.limit}:{})} : undefined));
  router.handle('task.details', A['task.details'], (_e, i) => deps.taskQueries.details(i.id));
  router.handle('task.readArtifact', A['task.readArtifact'], (_e, i) => deps.taskQueries.readArtifact(i));
  router.handle('task.thread', A['task.thread'], (_e, i) => deps.taskQueries.thread(i.threadId));
  router.handle('task.retry', A['task.retry'], (_e, i) => {
    const task = orchestrator.getTask(i.id);
    if (!task || task.state !== 'BLOCKED') throw new Error('Only blocked tasks can be retried. Use Resume for interrupted work.');
    const started = deps.store.db.prepare("SELECT 1 FROM task_steps WHERE task_id=? AND status!='succeeded' AND started_at IS NOT NULL").get(i.id);
    if (started) throw new Error('This task already started a step. Use Resume and confirm re-execution.');
    deps.runner.drive(i.id);
  });
  router.handle('registry.listAdapters', RegistryListAdaptersRequest, () => deps.registry.listAdapters());
  router.handle('approval.list', A['approval.list'], () => {
    deps.permissions.expireTimedOut();
    return orchestrator.listActive().flatMap((t) => deps.permissions.pendingApprovals(t.id));
  });
  router.handle('approval.resolve', ApprovalResolveRequest, (_e,i) => deps.runner.resolveApproval({approvalId:i.approvalId,decision:i.decision,...(i.remember !== undefined ? {remember:i.remember} : {})}));
  router.handle('permission.getProfile', A['permission.getProfile'], () =>
    deps.permissions.grantsFor({type:'agent',id:'orchestrator'})[0]?.profile ?? 'read_only');
  router.handle('permission.setProfile', A['permission.setProfile'], (_e,i) => {
    const subject = {type:'agent' as const,id:'orchestrator'};
    deps.permissions.revoke({subject});
    deps.permissions.grant({subject,profile:i.profile});
    return i.profile;
  });
  router.handle('audit.list', A['audit.list'], (_e,i) => deps.audit.recent(i?.limit ?? 100));

  router.handle(
    'workspace.list',
    WorkspaceListRequest,
    (): Workspace[] => workspaces.list(),
  );

  router.handle(
    'workspace.create',
    WorkspaceCreateRequest,
    (_event, input): Workspace => workspaces.create(input),
  );

  // A thread's changes come from its own worktree when one exists; the
  // project checkout itself is never where the agent wrote.
  const changesRoot = (workspaceId: string, taskId?: string): { root: string; branch?: string } => {
    const workspace = workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error(`Workspace ${workspaceId} not found`);
    if (taskId === undefined) return { root: workspace.rootPath };
    const task = deps.orchestrator.getTask(taskId);
    const key = task?.threadId ?? taskId;
    const path = worktreePathFor(workspace.rootPath, key);
    return existsSync(path) ? { root: path, branch: worktreeBranch(key) } : { root: workspace.rootPath };
  };

  router.handle('workspace.changes', A['workspace.changes'], async (_event, input) => {
    const { root, branch } = changesRoot(input.workspaceId, input.taskId);
    const changes = await listWorkspaceChanges(root);
    return { ...changes, ...(branch !== undefined ? { worktree: true, branch } : {}) };
  });

  router.handle('workspace.fileDiff', A['workspace.fileDiff'], async (_event, input) => {
    const { root } = changesRoot(input.workspaceId, input.taskId);
    return readWorkspaceFileDiff(root, input.path);
  });

  router.handle('question.list', A['question.list'], () => deps.questions?.listPending() ?? []);
  router.handle('question.answer', A['question.answer'], (_event, input) => {
    if (deps.questions === undefined || !deps.questions.answer(input.id, input.answers)) {
      throw new Error('That question is no longer waiting for an answer.');
    }
  });

  router.handle('workspace.select', WorkspaceSelectRequest, (_event, input) => {
    workspaces.select(input.id);
  });

  router.handle('workspace.delete', WorkspaceDeleteRequest, async (_event, input): Promise<ProjectDeletionResult> => {
    if (deps.deleteProject === undefined) throw new Error('Deleting projects is not available.');
    return deps.deleteProject(input.id);
  });

  router.handle('task.deleteThread', ThreadDeleteRequest, async (_event, input): Promise<ThreadDeletionResult> => {
    if (deps.deleteThread === undefined) throw new Error('Deleting threads is not available.');
    return deps.deleteThread(input.threadId);
  });

  router.handle('task.renameThread', ThreadRenameRequest, (_event, input): Task => {
    const { rootTaskId } = renameThread(deps.store, input.threadId, input.title);
    const task = orchestrator.getTask(rootTaskId);
    if (task === undefined) throw new Error('That thread no longer exists.');
    return task;
  });

  router.handle('usage.summary', UsageSummaryRequest, async (_event, input): Promise<UsageSummary> => {
    if (deps.usageSummary === undefined) throw new Error('Usage is not available.');
    // Validation above has already rejected unknown ranges, so this query is
    // exactly the extended overview contract (including `clients` and limits).
    const query: UsageSummaryQuery = {
      range: input.range,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.refreshLimits ? { refreshLimits: true } : {}),
    };
    // Only a manual refresh waits for the CLI probes; initial loads and range
    // changes read the snapshots already stored locally. A temporary
    // provider/CLI failure must not hide the last valid snapshot either way.
    if (query.refreshLimits) await deps.refreshUsageLimits?.().catch(() => undefined);
    return deps.usageSummary(query);
  });

  router.handle(
    'settings.get',
    SettingsGetRequest,
    (_event, input): unknown => {
      const resolved = settings.resolve(input.key);
      // NO_VALUE cannot cross IPC; surface it as null ("no value defined").
      return resolved === NO_VALUE ? null : resolved;
    },
  );

  router.handle('settings.set', SettingsSetRequest, (_event, input) => {
    settings.set(input);
  });

  // ---- Task lifecycle (Requirement 5.1, 5.2, 5.3) ----

  // Create a task (persisted in CREATED, no side effects beyond persistence),
  // then kick off execution fire-and-forget: beginExecution carries the task
  // through CONTEXT_LOADING → PLANNING, with progress streamed via events.
  // Validation failures reject before any task is created and surface as a
  // typed handler error to the renderer.
  router.handle(
    'task.create',
    TaskCreateRequest,
    async (_event, input): Promise<Task> => {
      return deps.runner.create({workspaceId:input.workspaceId,objective:input.objective,...(input.attachmentIds ? {attachmentIds:input.attachmentIds}:{}),...(input.acceptanceCriteria ? {acceptanceCriteria:input.acceptanceCriteria}:{}),...(input.parentTaskId ? {parentTaskId:input.parentTaskId}:{}),...(input.agentId ? {agentId:input.agentId}:{}),...(input.plan === true ? {plan:true}:{}),...(input.runOptions ? {runOptions:parseRunOptions(input.runOptions)}:{})});
    },
  );

  router.handle(
    'task.cancel',
    TaskCancelRequest,
    async (_event, input): Promise<void> => {
      await orchestrator.cancelTask(input.id);
    },
  );

  router.handle('task.get', TaskGetRequest, (_event, input): Task => {
    const task = orchestrator.getTask(input.id);
    if (task === undefined) {
      throw new Error(`Task ${input.id} not found`);
    }
    return task;
  });

  router.handle(
    'task.listActive',
    TaskListActiveRequest,
    (): Task[] => orchestrator.listActive(),
  );

  // ---- Resume Center (Requirement 8.5–8.8) ----

  // The boot-time reconciliation snapshot the Resume Center UI renders. Served
  // from the ResumeCenter's cached onBoot result so a renderer request never
  // re-probes adapter liveness.
  router.handle(
    'resume.snapshot',
    ResumeSnapshotRequest,
    (): ResumeSnapshot => resumeCenter.snapshot(),
  );

  // Carry out a per-task Resume Center action (resume / inspect / restart /
  // discard). The confirmation gate for a consequential resume (8.7) and for a
  // discard (8.8) is enforced inside the service: an unconfirmed consequential
  // resume or discard returns `confirmation_required` and performs no action.
  router.handle(
    'resume.act',
    ResumeActRequest,
    async (_event, input): Promise<ResumeActResult> => {
      const mutatesExecution = input.action === 'resume' || input.action === 'restart';
      if (mutatesExecution && (deps.runner.isRunning(input.taskId) || resumeInFlight.has(input.taskId))) {
        throw new Error('Task execution is already active. Inspect or cancel it before resuming.');
      }
      if (mutatesExecution) resumeInFlight.add(input.taskId);
      try {
        const result = await resumeService.act({
          taskId: input.taskId,
          action: input.action,
          ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
        });
        if (result.status === 'applied' && result.state === 'VERIFYING') deps.runner.drive(input.taskId);
        return result;
      } finally {
        if (mutatesExecution) resumeInFlight.delete(input.taskId);
      }
    },
  );

  // ---- Agent CLI Catalog (Requirement 4.1, 4.5, 5.1, 5.7, 6.1–6.3) ----

  // The last-scanned view of every supported CLI. Served from the catalog's
  // cache so a plain list never re-probes PATH (Requirement 4.1).
  router.handle(
    'cli.catalog.list',
    CliCatalogListRequest,
    (): CatalogEntryView[] => cliCatalog.list(),
  );

  // Explicitly re-evaluate every entry against PATH, reconcile the Registry,
  // and return the refreshed views (Requirement 4.5).
  router.handle(
    'cli.catalog.rescan',
    CliCatalogRescanRequest,
    (): CatalogEntryView[] => cliCatalog.rescan(),
  );

  // The exact command an install would run, for display in the confirm step.
  // Unknown ids and unconfigured entries throw, mapped to a typed
  // handler error by the router (Requirement 5.1, 5.7).
  router.handle(
    'cli.catalog.installCommand',
    CliCatalogInstallCommandRequest,
    (_event, input): string => cliCatalog.installCommand(input.entryId),
  );

  // Install an entry behind the confirmation gate; an unconfirmed request runs
  // nothing and returns `confirmation_required` (Requirement 6.1, 6.2, 6.3).
  router.handle(
    'cli.catalog.install',
    CliCatalogInstallRequest,
    (_event, input): Promise<InstallOutcome> =>
      cliCatalog.install({ entryId: input.entryId, confirmed: input.confirmed }),
  );

  // ---- Data control & external-flow consent (Requirement 21) ----

  // The current user-configurable data-control settings (retention, indexing,
  // sync), with local-first defaults filled in (Requirement 21.2, 21.5).
  router.handle(
    'dataControl.getSettings',
    DataControlGetSettingsRequest,
    (): DataControlSettings => dataControl.getSettings(),
  );

  // Update one or more settings; omitted fields keep their current value.
  // Returns the resolved settings after the update (Requirement 21.2).
  router.handle(
    'dataControl.setSettings',
    DataControlSetSettingsRequest,
    (_event, input): DataControlSettings => dataControl.updateSettings(input),
  );

  // The active (non-revoked) external-flow consents (Requirement 21.4, 21.5).
  router.handle(
    'dataControl.listConsents',
    DataControlListConsentsRequest,
    (): ExternalFlowConsent[] => dataControl.listConsents(),
  );

  // Grant / revoke the user's explicit consent to external flows per provider.
  router.handle(
    'dataControl.grantConsent',
    DataControlGrantConsentRequest,
    (_event, input): ExternalFlowConsent =>
      dataControl.grantConsent(input.provider),
  );

  router.handle(
    'dataControl.revokeConsent',
    DataControlRevokeConsentRequest,
    (_event, input): void => {
      dataControl.revokeConsent(input.provider);
    },
  );

  // Delete stored data for the given target and return a completion
  // confirmation the UI displays (Requirement 21.3).
  router.handle(
    'dataControl.delete',
    DataControlDeleteRequest,
    async (_event, input): Promise<DataDeletionResult> => {
      if ((input.target === 'tasks' || input.target === 'all') && orchestrator.listActive().length > 0) {
        throw new Error('Cancel active tasks before deleting task history.');
      }
      const result = dataControl.deleteStoredData(input.target);
      try { await deps.flushMemories?.(); }
      catch (error) {
        if (!(error instanceof Mem0Error)) throw error;
        result.memoryCleanupPending = true;
        result.confirmation += ' Remote memory cleanup is pending and will retry automatically.';
      }
      return result;
    },
  );
}
