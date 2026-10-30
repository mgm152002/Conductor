import { z } from 'zod';
import { KNOWLEDGE_SCHEMAS } from './knowledge-contract';
import { AUTOMATION_SCHEMAS } from './automation-contract';
import { APPLICATION_SCHEMAS } from './application-contract';
import { CONNECTOR_SCHEMAS } from './connector-contract';
import { INTEGRATION_SCHEMAS } from './integrations-contract';
import { CHAT_SCHEMAS } from './chat-contract';
import { GITHUB_SCHEMAS } from './github-contract';
import { AttachmentIdsSchema } from './attachments';

// The single source of truth for the IPC surface. Every invoke channel has a
// request schema validated in the main process before its handler runs, and a
// declared result type. Event channels (main -> renderer) are an explicit
// allowlist. The preload bridge and the main-process router both import from
// here so the contract cannot drift between the two sides.

// ---- Shared value schemas ----

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const PreferenceScopeSchema = z.enum(['global', 'workspace']);
export const ApprovalDecisionSchema = z.enum(['approved', 'denied']);
export const ResumeActionSchema = z.enum([
  'resume',
  'inspect',
  'restart',
  'discard',
]);

// ---- Invoke channel request schemas ----

export const WorkspaceListRequest = z.void();
export const WorkspaceCreateRequest = z.object({
  name: z.string().min(1).max(255),
  rootPath: z.string().min(1),
});
export const WorkspaceSelectRequest = z.object({ id: z.string().uuid() });
export const WorkspaceDeleteRequest = z.object({
  id: z.string().uuid(),
  // Required confirmation; the renderer sends it only after the user confirms.
  confirmed: z.literal(true),
});

export const UsageSummaryRequest = z.object({
  range: z.enum(['24h', '7d', '30d', '90d', 'all']),
  workspaceId: z.string().uuid().optional(),
  /** Manual refreshes ask the main process to probe CLIs before reading. */
  refreshLimits: z.boolean().optional(),
});

export const SettingsGetRequest = z.object({ key: z.string().min(1) });
export const SettingsSetRequest = z.object({
  key: z.string().min(1),
  value: jsonValue,
  scope: PreferenceScopeSchema,
});

const RunChoiceSchema = z.object({
  model: z.string().regex(/^[\w./:@-]{1,100}$/).optional(),
  effort: z.string().regex(/^[a-z]{2,12}$/).optional(),
});

export const TaskCreateRequest = z.object({
  workspaceId: z.string().uuid(),
  objective: z.string().trim().min(1).max(10_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(50).optional(),
  /** Continue an existing conversation thread from this task. */
  parentTaskId: z.string().uuid().optional(),
  /** Run on this agent (adapter id) instead of automatic routing. */
  agentId: z.string().trim().regex(/^[\w:.-]{1,200}$/).optional(),
  /** Plan mode: `agentId` writes a plan and the plan's tasks run on their agents. */
  plan: z.boolean().optional(),
  /** Model and effort for the agent (or planner) and, in plan mode, per sub-agent. Omitted = Auto. */
  runOptions: z.object({
    main: RunChoiceSchema.optional(),
    agents: z.record(z.string().regex(/^[\w:.-]{1,200}$/), RunChoiceSchema).optional(),
  }).optional(),
  /** Ids of attachments already ingested by the main process (max 10). */
  attachmentIds: AttachmentIdsSchema.optional(),
});
export const TaskCancelRequest = z.object({ id: z.string().uuid() });
export const TaskGetRequest = z.object({ id: z.string().uuid() });
export const TaskListActiveRequest = z.void();
export const ThreadDeleteRequest = z.object({
  threadId: z.string().uuid(),
  // Required confirmation; the renderer sends it only after the user confirms.
  confirmed: z.literal(true),
});
export const ThreadRenameRequest = z.object({
  threadId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
});

export const ResumeSnapshotRequest = z.void();
export const ResumeActRequest = z.object({
  taskId: z.string().uuid(),
  action: ResumeActionSchema,
  // Explicit user confirmation. A `resume` that would re-execute a
  // consequential / destructive / external-communication / financial action
  // (Requirement 8.7) and any `discard` (Requirement 8.8) are refused unless
  // this is true — the main process never acts on an unconfirmed consequential
  // resume or discard, so the confirmation gate cannot be bypassed from the
  // renderer.
  confirmed: z.boolean().optional(),
});

export const ApprovalResolveRequest = z.object({
  approvalId: z.string().uuid(),
  decision: ApprovalDecisionSchema,
  /** For an agent tool call: allow similar actions for the rest of the session. */
  remember: z.boolean().optional(),
});

export const CliCatalogListRequest = z.void();
export const CliCatalogRescanRequest = z.void();
export const CliCatalogInstallCommandRequest = z.object({
  entryId: z.string().min(1),
});
export const CliCatalogInstallRequest = z.object({
  entryId: z.string().min(1),
  // Explicit user confirmation of the exact install command shown in the
  // renderer. This is a REQUIRED boolean — a missing flag fails validation
  // rather than defaulting to a run, so the install service never executes a
  // command the user has not confirmed (Requirement 5.2, 5.3).
  confirmed: z.boolean(),
});

export const RegistryListAdaptersRequest = z.void();

// ---- Data control & external-flow consent (Requirement 21) ----

export const DataDeletionTargetSchema = z.enum([
  'all',
  'tasks',
  'context_items',
  'ingested_items',
  'audit_events',
]);

export const DataControlGetSettingsRequest = z.void();
export const DataControlSetSettingsRequest = z.object({
  retentionDays: z.number().int().min(0).optional(),
  indexingEnabled: z.boolean().optional(),
  syncEnabled: z.boolean().optional(),
});
export const DataControlListConsentsRequest = z.void();
export const DataControlGrantConsentRequest = z.object({
  provider: z.string().min(1),
});
export const DataControlRevokeConsentRequest = z.object({
  provider: z.string().min(1),
});
export const DataControlDeleteRequest = z.object({
  target: DataDeletionTargetSchema,
});

export const ThemeGetRequest = z.void();

// macOS appearance resolved by `nativeTheme` in the main process. The renderer
// never guesses from a media query; the main process is the single authority
// and pushes changes over the `theme.changed` event channel.
export const AppearanceSchema = z.enum(['dark', 'light']);
export type Appearance = z.infer<typeof AppearanceSchema>;

// ---- Invoke channel allowlist ----
//
// The keys are the exact ipcMain channel names. Each entry carries the request
// schema used by `withValidation`. Anything not present here is dropped and
// audited by the router.

export const INVOKE_SCHEMAS = {
  ...GITHUB_SCHEMAS,
  ...CHAT_SCHEMAS,
  ...KNOWLEDGE_SCHEMAS,
  ...AUTOMATION_SCHEMAS,
  ...APPLICATION_SCHEMAS,
  ...CONNECTOR_SCHEMAS,
  ...INTEGRATION_SCHEMAS,
  'workspace.list': WorkspaceListRequest,
  'workspace.create': WorkspaceCreateRequest,
  'workspace.select': WorkspaceSelectRequest,
  'workspace.delete': WorkspaceDeleteRequest,
  'usage.summary': UsageSummaryRequest,
  'settings.get': SettingsGetRequest,
  'settings.set': SettingsSetRequest,
  'task.create': TaskCreateRequest,
  'task.cancel': TaskCancelRequest,
  'task.get': TaskGetRequest,
  'task.listActive': TaskListActiveRequest,
  'task.deleteThread': ThreadDeleteRequest,
  'task.renameThread': ThreadRenameRequest,
  'resume.snapshot': ResumeSnapshotRequest,
  'resume.act': ResumeActRequest,
  'approval.resolve': ApprovalResolveRequest,
  'cli.catalog.list': CliCatalogListRequest,
  'cli.catalog.rescan': CliCatalogRescanRequest,
  'cli.catalog.installCommand': CliCatalogInstallCommandRequest,
  'cli.catalog.install': CliCatalogInstallRequest,
  'registry.listAdapters': RegistryListAdaptersRequest,
  'theme.get': ThemeGetRequest,
  'dataControl.getSettings': DataControlGetSettingsRequest,
  'dataControl.setSettings': DataControlSetSettingsRequest,
  'dataControl.listConsents': DataControlListConsentsRequest,
  'dataControl.grantConsent': DataControlGrantConsentRequest,
  'dataControl.revokeConsent': DataControlRevokeConsentRequest,
  'dataControl.delete': DataControlDeleteRequest,
} as const satisfies Record<string, z.ZodTypeAny>;

export type InvokeChannel = keyof typeof INVOKE_SCHEMAS;

export const INVOKE_CHANNELS = Object.keys(INVOKE_SCHEMAS) as InvokeChannel[];

export function isInvokeChannel(channel: string): channel is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(INVOKE_SCHEMAS, channel);
}

// ---- Event channel allowlist (main -> renderer) ----
//
// Defined in a dedicated, Zod-free module so the SANDBOXED preload can import
// the allowlist without transitively pulling in `zod` (which a sandboxed
// preload cannot `require`). Re-exported here so existing importers are
// unchanged.
export { EVENT_CHANNELS, isEventChannel } from './event-channels';
export type { EventChannel } from './event-channels';

// ---- Payload size limit ----

/** Maximum accepted invoke payload size in bytes (1 MiB). */
export const MAX_IPC_PAYLOAD_BYTES = 1024 * 1024;

// ---- Typed IPC error returned to the renderer ----

export type IpcErrorCode =
  | 'payload_too_large'
  | 'validation_failed'
  | 'unknown_channel'
  | 'handler_error';

export interface IpcError {
  readonly ok: false;
  readonly error: {
    readonly code: IpcErrorCode;
    readonly message: string;
    readonly channel?: string;
    /** Field-level validation issues, when code is `validation_failed`. */
    readonly issues?: { path: string; message: string }[];
  };
}

export interface IpcSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type IpcResult<T> = IpcSuccess<T> | IpcError;
