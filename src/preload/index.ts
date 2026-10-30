import type { AttachmentBridge } from '@shared/attachments';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
// Runtime values come from the Zod-free module so this sandboxed preload never
// transitively requires `zod` (which it cannot resolve). Types are erased at
// compile time, so type-only imports from ipc-contract are safe.
import {
  EVENT_CHANNELS,
  isEventChannel,
  type EventChannel,
} from '@shared/event-channels';
import type { IpcResult } from '@shared/ipc-contract';
import type { Appearance } from '@shared/ipc-contract';
import type {
  AdapterRecord,
  DataControlSettings,
  DataDeletionResult,
  DataDeletionTarget,
  ExternalFlowConsent,
  ResumeAction,
  ResumeActResult,
  ProjectDeletionResult,
  Task,
  ThreadDeletionResult,
  Workspace,
  ResumeSnapshot,
} from '@shared/domain';
import type { UsageRange, UsageSummary } from '@shared/usage';
import type { RunOptions } from '@shared/agent-models';
import type { KnowledgeBridge } from '@shared/knowledge-contract';
import type { AutomationBridge } from '@shared/automation-contract';
import type { ConnectorBridge, SystemBridge } from '@shared/connector-contract';
import type { IntegrationsBridge } from '@shared/integrations-contract';
import type { ArtifactPreview, ChangedFileDiff, TaskDetails, WorkspaceChanges } from '@shared/task-view';
import type { AgentQuestionAnswers, AgentQuestionRequest, ApprovalRequest, AuditEvent, PermissionProfile } from '@shared/domain';
import type { CatalogEntryView, InstallOutcome } from '@shared/catalog';
import type { ChatBridge, ChatConversation } from '@shared/chat-contract';
import type { GitHubBridge } from '@shared/github-contract';

// The preload bridge exposes exactly one namespaced object, `window.conductor`.
// It is the only surface the sandboxed renderer can reach: typed `invoke`
// wrappers over the allowlisted channels, and a single `on` subscription for
// redacted main -> renderer events. No `require`, no Node handle, no raw
// ipcRenderer is ever exposed.

/**
 * Invoke a validated main-process channel. The main side always replies with
 * an `IpcResult`; this helper unwraps success and throws a plain Error on the
 * typed failure so renderer callers can use normal try/catch.
 */
async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  if (result.ok) {
    return result.value;
  }
  const error = new Error(result.error.message);
  error.name = `IpcError:${result.error.code}`;
  throw error;
}

const memory: KnowledgeBridge['memory'] = {
  search: (input) => invoke('memory.search',input), create: (input) => invoke('memory.create',input),
  inspect: (id) => invoke('memory.inspect',{id}), correct: (input) => invoke('memory.correct',input), delete: (id) => invoke('memory.delete',{id}),
};
const context: KnowledgeBridge['context'] = {
  list: (input) => invoke('context.list',input), create: (input) => invoke('context.create',input),
  inspect: (id) => invoke('context.inspect',{id}), correct: (input) => invoke('context.correct',input), delete: (id) => invoke('context.delete',{id}),
};
const workflows: AutomationBridge['workflows'] = {
  list:()=>invoke('workflow.list'),get:(input)=>invoke('workflow.get',input), save:(input)=>invoke('workflow.save',input),
  versions:(workflowId)=>invoke('workflow.versions',{workflowId}), history:(workflowId)=>invoke('workflow.history',{workflowId}),
  start:(input)=>invoke('workflow.start',input),test:(input)=>invoke('workflow.test',input),
};
const skills: AutomationBridge['skills'] = {
  list:()=>invoke('skill.list'),get:(skillId)=>invoke('skill.get',{skillId}),save:(input)=>invoke('skill.save',input),
  versions:(skillId)=>invoke('skill.versions',{skillId}),version:(input)=>invoke('skill.version',input),
  rollback:(input)=>invoke('skill.rollback',input),export:(input)=>invoke('skill.export',input),
  listBindings:(input)=>invoke('skill.binding.list',input),saveBinding:(input)=>invoke('skill.binding.save',input),
  setBindingStatus:(input)=>invoke('skill.binding.setStatus',input),removeBinding:(input)=>invoke('skill.binding.remove',input),
  listUsages:(input)=>invoke('skill.usage.list',input),
};
const connectors: ConnectorBridge = {
  list: () => invoke('connector.list'),
  createFolder: (input) => invoke('connector.createFolder', input),
  createEmail: (input) => invoke('connector.createEmail', input),
  createCalendar: (input) => invoke('connector.createCalendar', input),
  createSlack: (input) => invoke('connector.createSlack', input),
  authorize: (id) => invoke('connector.authorize', { id }),
  sync: (input) => invoke('connector.sync', input),
  revoke: (id) => invoke('connector.revoke', { id }),
  delete: (id) => invoke('connector.delete', { id }),
  items: (input) => invoke('connector.items', input),
};
const system: SystemBridge = {
  pickDirectory: (input) => invoke('system.pickDirectory', input),
};
const integrations: IntegrationsBridge = {
  agents: { list: () => invoke('agents.list'), models: (agentId, refresh) => invoke('agents.models', { agentId, ...(refresh ? { refresh: true } : {}) }) },
  secrets: { list: () => invoke('secret.list'), delete: (id) => invoke('secret.delete', { id }) },
  mcp: {
    list: () => invoke('mcp.list'), discover: () => invoke('mcp.discover'), add: (input) => invoke('mcp.add', input),
    approve: (id) => invoke('mcp.approve', { id }), disable: (id) => invoke('mcp.disable', { id }),
    remove: (id) => invoke('mcp.remove', { id }), checkHealth: (id) => invoke('mcp.checkHealth', { id }),
    invoke: (input) => invoke('mcp.invoke', input),
  },
  remote: {
    list: () => invoke('remote.list'), add: (input) => invoke('remote.add', input), remove: (id) => invoke('remote.remove', { id }),
    setEnabled: (input) => invoke('remote.setEnabled', input), test: (id) => invoke('remote.test', { id }),
  },
  suggestions: {
    list: () => invoke('suggestion.list'), confirm: (input) => invoke('suggestion.confirm', input),
    dismiss: (id) => invoke('suggestion.dismiss', { id }), rules: () => invoke('suggestion.rules'),
    removeRule: (actionKind) => invoke('suggestion.removeRule', { actionKind }),
  },
  learning: {
    proposals: () => invoke('learning.proposals'), approve: (id) => invoke('learning.approve', { id }),
    reject: (id) => invoke('learning.reject', { id }), stats: () => invoke('learning.stats'),
    status: () => invoke('learning.status'), setConfig: (input) => invoke('learning.setConfig', input),
    runNow: () => invoke('learning.runNow'),
    purgeRoutingApprovals: () => invoke('learning.purgeRoutingApprovals', { confirmed: true }),
  },
};
const attachment: AttachmentBridge = {
  pick: () => invoke('attachment.pick'),
  ingest: (input) => invoke('attachment.ingestPaths', input),
  ingestBytes: (input) => invoke('attachment.ingestBytes', input),
  preview: (id) => invoke('attachment.preview', { id }),
  thumbnail: (id) => invoke('attachment.thumbnail', { id }),
  discard: (id) => invoke('attachment.discard', { id }),
};

const chat: ChatBridge = {
  list: () => invoke('chat.list'),
  get: (threadId) => invoke('chat.get', { threadId }),
  send: (input) => invoke('chat.send', input),
  cancel: (threadId) => invoke('chat.cancel', { threadId }),
  delete: (threadId) => invoke('chat.delete', { threadId }),
  rename: (threadId, title) => invoke('chat.rename', { threadId, title }),
  listSpaces: () => invoke('chat.listSpaces'),
  createSpace: (name) => invoke('chat.createSpace', { name }),
  renameSpace: (spaceId, name) => invoke('chat.renameSpace', { spaceId, name }),
  deleteSpace: (spaceId) => invoke('chat.deleteSpace', { spaceId }),
  setThreadSpace: (threadId, spaceId) => invoke('chat.setThreadSpace', { threadId, spaceId }),
  mem0Health: () => invoke('chat.mem0Health'),
};

function on(channel: 'chat.updated', handler: (payload: ChatConversation) => void): () => void;
function on(channel: EventChannel, handler: (payload: unknown) => void): () => void;
function on(channel: EventChannel, handler: ((payload: ChatConversation) => void) | ((payload: unknown) => void)): () => void {
  if (!isEventChannel(channel)) throw new Error(`Unknown event channel: ${String(channel)}`);
  const listener = (_event: IpcRendererEvent, payload: unknown): void => { (handler as (payload: unknown) => void)(payload); };
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

/**
 * Query accepted by the usage overview bridge. `range` mirrors the shared
 * `UsageRange` union; the main process validates it against
 * `UsageSummaryRequest` and rejects unknown values.
 */
export interface UsageSummaryQuery {
  range: UsageRange;
  workspaceId?: string;
  /** Set only by a manual refresh so the main process probes CLIs first. */
  refreshLimits?: boolean;
}

const github: GitHubBridge = {
  status: (workspaceId) => invoke('github.status', { workspaceId }),
  connect: (input) => invoke('github.connect', input),
  disconnect: (workspaceId) => invoke('github.disconnect', { workspaceId }),
  setAutoPr: (input) => invoke('github.setAutoPr', input),
  setBaseBranch: (input) => invoke('github.setBaseBranch', input),
  listPrs: (workspaceId) => invoke('github.listPrs', { workspaceId }),
  refreshPrs: (workspaceId) => invoke('github.refreshPrs', { workspaceId }),
  createPr: (input) => invoke('github.createPr', input),
  openPr: (url) => invoke('github.openPr', { url }),
  getPr: (input) => invoke('github.getPr', input),
  mergePr: (input) => invoke('github.mergePr', input),
  commentPr: (input) => invoke('github.commentPr', input),
  reviewPr: (input) => invoke('github.reviewPr', input),
  setPrState: (input) => invoke('github.setPrState', input),
};

const conductor = {
  github,
  chat,
  attachment,
  memory, context, workflows, skills, connectors, system, ...integrations,
  permissions: {
    getProfile: ():Promise<PermissionProfile> => invoke('permission.getProfile'),
    setProfile: (profile:PermissionProfile):Promise<PermissionProfile> => invoke('permission.setProfile',{profile}),
  },
  audit: {list: (input?:{limit?:number}):Promise<AuditEvent[]> => invoke('audit.list',input)},
  workspace: {
    active: ():Promise<string|null> => invoke('workspace.active'),
    list: (): Promise<Workspace[]> => invoke('workspace.list'),
    create: (input: { name: string; rootPath: string }): Promise<Workspace> =>
      invoke('workspace.create', input),
    select: (id: string): Promise<void> => invoke('workspace.select', { id }),
    /** Delete a project and everything Conductor stored for it (not its files). */
    delete: (id: string): Promise<ProjectDeletionResult> => invoke('workspace.delete', { id, confirmed: true }),
    /** Uncommitted files in the project (or thread worktree) working tree. */
    changes: (workspaceId: string, taskId?: string): Promise<WorkspaceChanges> => invoke('workspace.changes', { workspaceId, ...(taskId ? { taskId } : {}) }),
    /** Unified diff for one changed file, capped and redacted by the main process. */
    fileDiff: (input: { workspaceId: string; path: string; taskId?: string }): Promise<ChangedFileDiff> => invoke('workspace.fileDiff', input),
  },
  usage: {
    /**
     * Extended usage overview for the selected range. `UsageSummary.clients`
     * carries every attached CLI and its session, daily, and weekly `limits`;
     * the legacy totals and breakdowns stay on the same response.
     */
    summary: (input: UsageSummaryQuery): Promise<UsageSummary> =>
      invoke<UsageSummary>('usage.summary', input),
  },
  settings: {
    get: (key: string): Promise<unknown> => invoke('settings.get', { key }),
    set: (input: {
      key: string;
      value: unknown;
      scope: 'global' | 'workspace';
    }): Promise<void> => invoke('settings.set', input),
  },
  task: {
    list: (input?:{workspaceId?:string;limit?:number}):Promise<Task[]> => invoke('task.list',input),
    details: (id:string):Promise<TaskDetails> => invoke('task.details',{id}),
    readArtifact: (input:{taskId:string;artifactId:string}):Promise<ArtifactPreview> => invoke('task.readArtifact',input),
    retry: (id:string):Promise<void> => invoke('task.retry',{id}),
    thread: (threadId:string):Promise<Task[]> => invoke('task.thread',{threadId}),
    /** Delete a thread and everything stored for its messages (not project files). */
    deleteThread: (threadId:string):Promise<ThreadDeletionResult> => invoke('task.deleteThread',{threadId,confirmed:true}),
    /** Rename a thread; resolves to its root task carrying the new title. */
    renameThread: (threadId:string,title:string):Promise<Task> => invoke('task.renameThread',{threadId,title}),
    create: (input: {
      workspaceId: string;
      objective: string;
      acceptanceCriteria?: string[];
      parentTaskId?: string;
      agentId?: string;
      /** Plan mode: `agentId` plans, and the plan's tasks run on their agents. */
      plan?: boolean;
      /** Model/effort choices; omitted means Auto (by difficulty). */
      runOptions?: RunOptions;
    }): Promise<Task> => invoke('task.create', input),
    cancel: (id: string): Promise<void> => invoke('task.cancel', { id }),
    get: (id: string): Promise<Task> => invoke('task.get', { id }),
    listActive: (): Promise<Task[]> => invoke('task.listActive'),
  },
  resume: {
    snapshot: (): Promise<ResumeSnapshot> => invoke('resume.snapshot'),
    act: (input: {
      taskId: string;
      action: ResumeAction;
      /**
       * Explicit user confirmation. Required for a resume that would
       * re-execute a consequential action (Requirement 8.7) and for any
       * discard (Requirement 8.8); without it the main process returns a
       * `confirmation_required` result and performs no action.
       */
      confirmed?: boolean;
    }): Promise<ResumeActResult> => invoke('resume.act', input),
  },
  question: {
    list: (): Promise<AgentQuestionRequest[]> => invoke('question.list'),
    answer: (input: { id: string; answers: AgentQuestionAnswers }): Promise<void> => invoke('question.answer', input),
  },
  approval: {
    list: ():Promise<ApprovalRequest[]> => invoke('approval.list'),
    resolve: (input: {
      approvalId: string;
      decision: 'approved' | 'denied';
      remember?: boolean;
    }): Promise<void> => invoke('approval.resolve', input),
  },
  registry: {
    listAdapters: (): Promise<AdapterRecord[]> =>
      invoke('registry.listAdapters'),
  },
  cliCatalog: {
    list: (): Promise<CatalogEntryView[]> => invoke('cli.catalog.list'),
    rescan: (): Promise<CatalogEntryView[]> => invoke('cli.catalog.rescan'),
    installCommand: (entryId: string): Promise<string> =>
      invoke('cli.catalog.installCommand', { entryId }),
    install: (input: {
      entryId: string;
      confirmed: boolean;
    }): Promise<InstallOutcome> => invoke('cli.catalog.install', input),
  },
  theme: {
    // The current macOS appearance resolved by `nativeTheme`. Changes arrive
    // over the `theme.changed` event channel (subscribe via `on`).
    get: (): Promise<Appearance> => invoke('theme.get'),
  },
  dataControl: {
    // User-configurable data-control settings (retention, indexing, sync),
    // local-first by default (Requirement 21.2, 21.5).
    getSettings: (): Promise<DataControlSettings> =>
      invoke('dataControl.getSettings'),
    setSettings: (
      input: Partial<DataControlSettings>,
    ): Promise<DataControlSettings> => invoke('dataControl.setSettings', input),
    // Per-provider consent gating external data flows (Requirement 21.4, 21.5).
    listConsents: (): Promise<ExternalFlowConsent[]> =>
      invoke('dataControl.listConsents'),
    grantConsent: (provider: string): Promise<ExternalFlowConsent> =>
      invoke('dataControl.grantConsent', { provider }),
    revokeConsent: (provider: string): Promise<void> =>
      invoke('dataControl.revokeConsent', { provider }),
    // Delete stored data and surface the completion confirmation (Req 21.3).
    delete: (target: DataDeletionTarget): Promise<DataDeletionResult> =>
      invoke('dataControl.delete', { target }),
    // External-flow indicators arrive over the `dataflow.external` event
    // channel; subscribe via `on('dataflow.external', ...)`.
  },
  /**
   * Subscribe to a redacted main -> renderer event. Unknown channels are
   * rejected here so the renderer cannot listen on arbitrary IPC names.
   * Returns an unsubscribe function.
   */
  on,
} as const;

// Freeze the surface so renderer code cannot monkey-patch the bridge.
for (const channel of EVENT_CHANNELS) {
  void channel;
}

contextBridge.exposeInMainWorld('conductor', conductor);

export type ConductorBridge = typeof conductor;
