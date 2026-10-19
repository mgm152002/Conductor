// Shared domain types mirrored from the design document's data model. These
// are the durable contracts shared across main, preload, and renderer. Zod
// schemas that validate IPC payloads live in `ipc-contract.ts`; these are the
// TypeScript shapes the schemas produce and the UI consumes.

export type PermissionProfile =
  | 'read_only'
  | 'assisted_execution'
  | 'trusted_automation';

/**
 * The source categories that are always untrusted on the data channel
 * (Requirement 11.1). Shared here as the single source of truth; the
 * orchestrator's data-channel seam (`src/main/orchestrator/data-channel.ts`)
 * re-exports this type so main-process code and shared/renderer code agree.
 */
export type UntrustedSource =
  | 'email'
  | 'web'
  | 'file'
  | 'tool_output'
  | 'agent_instruction';

export interface Workspace {
  id: string; // uuid v4
  name: string;
  rootPath: string; // absolute, canonicalized
  createdAt: string; // ISO-8601 UTC
  updatedAt: string;
}

export type PreferenceScope = 'global' | 'workspace';

export interface Preference {
  key: string; // namespaced, e.g. "ui.theme"
  value: unknown; // JSON-serializable
  scope: PreferenceScope;
  workspaceId?: string;
}

export type TaskState =
  | 'CREATED'
  | 'CONTEXT_LOADING'
  | 'PLANNING'
  | 'WAITING_FOR_APPROVAL'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'RECOVERABLE_INTERRUPTION';

export interface Task {
  id: string;
  workspaceId: string;
  objective: string;
  acceptanceCriteria: string[];
  state: TaskState;
  contextRefs: string[];
  recommendedNextAction?: string;
  lastVerifiedCheckpointId?: string;
  /**
   * The conversation thread this task belongs to: the id of the thread's first
   * task. Absent on tasks created before threads existed (treat as own id).
   */
  threadId?: string;
  /** The previous task in the thread this task follows up on. */
  parentTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface TaskStep {
  id: string;
  taskId: string;
  ordinal: number;
  description: string;
  dependsOn: string[];
  assignedAdapterId?: string;
  inputSchemaRef?: string;
  status: TaskStepStatus;
  startedAt?: string;
  endedAt?: string;
  /** Model and effort the step's agent ran with, and how they were chosen. */
  run?: { model?: string; effort?: string; source: 'composer' | 'settings' | 'auto' | 'default'; difficulty?: 'simple' | 'moderate' | 'complex' };
}

export interface Checkpoint {
  id: string;
  taskId: string;
  stepId?: string;
  state: TaskState;
  snapshot: unknown;
  verified: boolean;
  createdAt: string;
}

export type TaskEventKind =
  | 'transition'
  | 'log'
  | 'artifact'
  | 'approval'
  | 'error'
  | 'stream';

export interface TaskEvent {
  id: string;
  taskId: string;
  stepId?: string;
  kind: TaskEventKind;
  payload: unknown;
  createdAt: string;
}

export type AgentSessionStatus =
  | 'starting'
  | 'live'
  | 'exited'
  | 'orphaned'
  | 'unknown';

export interface AgentSession {
  id: string;
  taskId: string;
  adapterId: string;
  externalRef?: string;
  status: AgentSessionStatus;
  resumable: boolean;
  lastHeartbeatAt?: string;
  exitCode?: number; // NOT a success signal by itself
  createdAt: string;
}

export type AdapterClass =
  | 'local_cli_agent'
  | 'model_provider'
  | 'external_service'
  | 'local_tool'
  | 'computer_interaction'
  | 'remote_execution';

export type PermissionRequirementKind =
  | 'filesystem_read'
  | 'filesystem_write'
  | 'command_exec'
  | 'network_egress'
  | 'external_comm'
  | 'financial'
  | 'destructive';

export interface PermissionRequirement {
  kind: PermissionRequirementKind;
  scope?: string;
}

export type CostHint = 'low' | 'medium' | 'high';
export type LatencyHint = 'low' | 'medium' | 'high';

export interface CapabilityDescriptor {
  id: string;
  title: string;
  inputSchema: unknown;
  outputSchema: unknown;
  streaming: boolean;
  cancellable: boolean;
  resumable: boolean;
  requiredPermissions: PermissionRequirement[];
  /**
   * The adapter asks for approval per tool call (command, file change) while it
   * runs, so the orchestrator does not gate the whole step up front. The
   * profile must still permit the requirements.
   */
  toolApprovals?: boolean;
  costHint?: CostHint;
  latencyHint?: LatencyHint;
}

export interface AdapterRecord {
  id: string;
  class: AdapterClass;
  name: string;
  version: string;
  capabilities: CapabilityDescriptor[];
  available: boolean;
  config: unknown; // non-secret config only
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  id: string;
  taskId: string;
  stepId?: string;
  summary: string;
  requirements: PermissionRequirement[];
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface AuditEvent {
  id: string;
  actor: string; // adapterId | 'orchestrator' | 'user'
  action: string;
  target?: string;
  redactedPayload: unknown; // secrets never present
  createdAt: string;
}

// ---- Memory & context (M4) ----

/** The level a context item or memory applies to (Requirement 12.1). */
export type ContextScopeLevel =
  | 'global'
  | 'project'
  | 'task'
  | 'workflow'
  | 'source';

export interface ContextScope {
  level: ContextScopeLevel;
  /** Id of the project/task/workflow/source the scope is bound to, when any. */
  refId?: string;
}

/** The trust classification of a context item or memory (Requirement 12.2). */
export type Veracity = 'observed_fact' | 'inferred' | 'unverified_assumption';

/** How a context item or memory came to exist. */
export type ProvenanceMethod =
  | 'ingested'
  | 'agent_output'
  | 'user_stated'
  | 'inferred';

/** The recorded origin of a context item or memory. */
export interface Provenance {
  /** Id of the originating source (connector item, document, ...), when any. */
  sourceId?: string;
  /** Ids of the items this was derived from, when inferred. */
  derivedFrom?: string[];
  method: ProvenanceMethod;
}

/**
 * A structured, source-linked unit of the Context Engine's model of active
 * work (Requirement 12). Each item carries a veracity classification, a
 * confidence in [0, 1], and at least one provenance source.
 */
export interface ContextItem {
  id: string;
  scope: ContextScope;
  content: string;
  veracity: Veracity;
  confidence: number; // 0.0 .. 1.0 inclusive
  provenance: Provenance[];
  createdAt: string;
  updatedAt: string;
}

// ---- Persistent memory engine (M4, Requirement 13) ----

/**
 * One of the four layers of the persistent Memory Engine (Requirement 13.1).
 * Every stored memory belongs to exactly one layer:
 *   - personal:   knowledge about the user that spans projects
 *   - project:    knowledge scoped to a single project
 *   - task:       knowledge scoped to a single task
 *   - procedural: how-to / procedural knowledge
 */
export type MemoryLayer = 'personal' | 'project' | 'task' | 'procedural';

/**
 * A durable, searchable unit of long-term knowledge (Requirement 13). Each
 * memory lives in exactly one {@link MemoryLayer}, carries a veracity
 * classification, a confidence in [0, 1], an origin {@link Provenance}, and a
 * {@link ContextScope}. `expiresAt`, when set and reached, marks the memory
 * expired and excludes it from search (Requirement 13.6). `supersededBy` points
 * at the memory that corrected or deduplicated this one (Requirement 13.5).
 */
export interface MemoryRecord {
  id: string;
  layer: MemoryLayer;
  content: string;
  veracity: Veracity;
  confidence: number; // 0.0 .. 1.0 inclusive
  provenance: Provenance;
  scope: ContextScope;
  /** When set and reached, the memory is expired and excluded from search. */
  expiresAt?: string;
  /** Id of the memory that supersedes this one (correction / dedup). */
  supersededBy?: string;
  createdAt: string;
}

/**
 * Why a {@link MemoryProvenanceEvent} was recorded against a memory. These are
 * the lifecycle events that change a memory's standing beyond its creation
 * origin: a supersession (correction/dedup, Requirement 13.5) or a veracity
 * promotion to observed_fact (Requirement 13.8).
 */
export type MemoryProvenanceEventKind =
  | 'created'
  | 'superseded_by' // this memory was superseded by another (it is stale)
  | 'supersedes' // this memory supersedes another (correction/dedup)
  | 'user_correction' // a user correction promoted veracity
  | 'verification'; // a verification event promoted veracity

/**
 * An append-only provenance event on a memory's history. Supersession events
 * reference both memory ids (Requirement 13.5); promotion events record the
 * triggering source id and timestamp (Requirement 13.8).
 */
export interface MemoryProvenanceEvent {
  id: string;
  memoryId: string;
  kind: MemoryProvenanceEventKind;
  /** The other memory in a supersession relationship, when any. */
  relatedMemoryId?: string;
  /** The source that triggered the event (user id, verifier id, source). */
  sourceId?: string;
  createdAt: string;
}

/** How a memory search is ranked/filtered (Requirement 13.3). */
export interface MemorySearchQuery {
  /** Natural-language query ranked by Mem0 semantic retrieval. */
  text?: string;
  /** Restrict to a layer. */
  layer?: MemoryLayer;
  /** Restrict to a project (matches scope.refId when scope.level=project). */
  projectId?: string;
  /** Restrict to memories whose provenance names this source id. */
  sourceId?: string;
  /** Only memories created at or after this ISO-8601 timestamp. */
  createdAfter?: string;
  /** Only memories created at or before this ISO-8601 timestamp. */
  createdBefore?: string;
  /** Maximum number of results to return (defaults to 50). */
  limit?: number;
}

/** A single ranked search hit (Requirement 13.3). */
export interface MemorySearchHit {
  memory: MemoryRecord;
  /** Relevance score; higher is more relevant. Results are score-descending. */
  score: number;
}

export type ResumeAction = 'resume' | 'inspect' | 'restart' | 'discard';
export type ResumeClassification =
  | 'RESUMABLE'
  | 'RECOVERABLE_INTERRUPTION'
  | 'BLOCKED';

export interface ResumeItem {
  taskId: string;
  objective: string;
  state: TaskState;
  classification: ResumeClassification;
  recommendedNextAction?: string;
  lastVerifiedCheckpointId?: string;
  requiresConfirmation: boolean;
}

export interface ResumeSnapshot {
  generatedAt: string;
  items: ResumeItem[];
}

/**
 * The outcome of a `resume.act` call. When `status` is
 * `confirmation_required` the Resume Center refused to act because the action
 * needs explicit user confirmation (a consequential resume — Requirement 8.7 —
 * or a discard — Requirement 8.8) and the request did not carry `confirmed`.
 * The caller must re-issue the same action with `confirmed: true` after the
 * user confirms. `applied` means the action was carried out; `noop` means there
 * was nothing to do (e.g. `inspect`, which never changes state).
 */
export type ResumeActStatus = 'applied' | 'confirmation_required' | 'noop';

export interface ResumeActResult {
  taskId: string;
  action: ResumeAction;
  status: ResumeActStatus;
  /** The task's state after the action (unchanged on confirmation_required). */
  state: TaskState;
  /**
   * Why confirmation is required, when `status` is `confirmation_required`:
   * `consequential` for a resume that would re-execute a
   * consequential/destructive/external/financial step, `discard` for a discard.
   */
  confirmationReason?: 'consequential' | 'discard';
}

// ---------------------------------------------------------------------------
// Workflow DAG engine (Requirement 15, Milestone M6)
// ---------------------------------------------------------------------------
//
// A DAG_Workflow is a reusable, versioned graph — not a saved prompt. It carries
// triggers, input/output schemas, required context, steps and dependencies,
// conditional branches, bounded loops, retry/timeout policies, approval
// requirements, validation criteria, an error-recovery policy, memory updates,
// and execution history. The graph must be acyclic and at most 500 steps.

/** The upper bound on the number of steps in a single workflow (Requirement 15.2). */
export const MAX_WORKFLOW_STEPS = 500;

/** How a workflow run is initiated. */
export type WorkflowTriggerKind = 'manual' | 'scheduled' | 'event';

export interface WorkflowTrigger {
  kind: WorkflowTriggerKind;
  /** Free-form configuration (cron expression, event name, etc.). */
  config?: unknown;
}

/**
 * A conditional branch attached to a step: when `expression` evaluates truthy
 * against the run's variable scope, only the steps named in `whenTrue` are
 * eligible to run among the branch targets; otherwise only `whenFalse`. Steps
 * not named in either list are unaffected by the branch.
 */
export interface WorkflowBranch {
  /** Boolean key looked up in the run's variable scope. */
  expression: string;
  whenTrue: string[];
  whenFalse: string[];
}

/**
 * A bounded loop over a step: the step body re-runs while `continueWhile` holds
 * in the run scope, up to `maxIterations` iterations. The bound is mandatory so
 * a loop can never run unbounded (Requirement 15.6).
 */
export interface WorkflowLoop {
  continueWhile: string;
  maxIterations: number;
}

/** Per-step retry and timeout policy (Requirement 15.6). */
export interface WorkflowStepPolicy {
  /** Maximum retry attempts after the initial attempt fails. */
  maxRetries: number;
  /** Abort the step if a single attempt exceeds this many milliseconds. */
  timeoutMs: number;
}

/** What to do when a step fails after exhausting its retries (Requirement 15.7). */
export type WorkflowErrorRecoveryKind =
  | 'abort' // stop the run and mark it failed
  | 'continue' // skip the failed step and keep going
  | 'compensate'; // run a named compensation step, then continue

export interface WorkflowErrorRecovery {
  kind: WorkflowErrorRecoveryKind;
  /** The step id to run when `kind` is `compensate`. */
  compensateWith?: string;
}

export interface WorkflowStep {
  /** Stable id, unique within the workflow; names dependency/branch edges. */
  id: string;
  description: string;
  /** The capability id the step needs an adapter (or automation) to provide. */
  requiredCapability: string;
  /** Ids of steps that must complete before this step may start. */
  dependsOn: string[];
  requiredPermissions?: PermissionRequirement[];
  /** When set, this step is a bounded loop. */
  loop?: WorkflowLoop;
  /** When set, this step conditionally gates its branch targets. */
  branch?: WorkflowBranch;
  /** Retry/timeout policy; falls back to engine defaults when omitted. */
  policy?: WorkflowStepPolicy;
  /** Whether running this step requires an approval gate. */
  requiresApproval?: boolean;
  /** Per-step error-recovery override; falls back to the workflow policy. */
  errorRecovery?: WorkflowErrorRecovery;
}

/** One criterion a workflow is tested against (Requirement 15.4). */
export interface WorkflowValidationCriterion {
  id: string;
  description: string;
}

/** A single memory write a workflow performs as part of its definition. */
export interface WorkflowMemoryUpdate {
  layer: string;
  key: string;
  value: unknown;
}

/**
 * The canonical, versioned workflow definition. `version` is monotonically
 * increasing within a `workflowId`; every prior version is retained so it can
 * be retrieved (Requirement 15.3).
 */
export interface DagWorkflow {
  id: string; // per-version row id (uuid)
  workflowId: string; // stable id shared across versions
  version: number; // monotonic within workflowId
  name: string;
  triggers: WorkflowTrigger[];
  inputSchema: unknown;
  outputSchema: unknown;
  requiredContext: string[];
  steps: WorkflowStep[];
  validationCriteria: WorkflowValidationCriterion[];
  errorRecovery: WorkflowErrorRecovery;
  memoryUpdates: WorkflowMemoryUpdate[];
  createdAt: string;
}

export type WorkflowStepOutcome = 'succeeded' | 'failed' | 'skipped';

/** One execution-history entry per executed step (Requirement 15.5). */
export interface WorkflowStepHistoryEntry {
  stepId: string;
  /** 1-based iteration index for loop bodies; 1 for ordinary steps. */
  iteration: number;
  startedAt: string;
  endedAt: string;
  outcome: WorkflowStepOutcome;
  /** Number of retry attempts consumed before this outcome. */
  attempts: number;
  /** Set when the outcome is driven by the error-recovery policy. */
  recoveryAction?: WorkflowErrorRecoveryKind;
  /** Human-readable failure/timeout detail. */
  detail?: string;
}

export type WorkflowRunStatus = 'completed' | 'failed' | 'aborted';

export interface WorkflowRunResult {
  workflowId: string;
  version: number;
  status: WorkflowRunStatus;
  history: WorkflowStepHistoryEntry[];
}

export type WorkflowValidationOutcome = 'pass' | 'fail';

export interface WorkflowCriterionResult {
  criterionId: string;
  outcome: WorkflowValidationOutcome;
  detail?: string;
}

export interface WorkflowTestReport {
  workflowId: string;
  version: number;
  /** Wall-clock milliseconds the test run took; must be reported ≤ 60s. */
  durationMs: number;
  results: WorkflowCriterionResult[];
}

// ---- Skills & procedural knowledge (M7) ----

/**
 * The scope at which a skill applies. A skill is agent-independent but can be
 * narrowed to a single project or a single workflow; `global` skills apply
 * everywhere. (Requirement 16.3)
 */
export type SkillScope = 'global' | 'project' | 'workflow';

/**
 * How a skill version came to exist, mirroring the Memory_Engine provenance
 * vocabulary: authored directly by the user, emitted by an agent, or proposed
 * by the self-learning engine. Every version records who/what produced it.
 */
export type SkillProvenanceMethod = 'user_authored' | 'agent_output' | 'inferred';

export interface SkillProvenance {
  method: SkillProvenanceMethod;
  /** Free-form source identifier: a user id, an adapter id, a run id, etc. */
  source: string;
}

/**
 * A single input or output contract entry for a skill: a named value with a
 * human description and whether it is required. The `schema` is an opaque
 * JSON-schema-like object (kept as `unknown` like CapabilityDescriptor's
 * schemas) so skills stay agent-independent.
 */
export interface SkillIoField {
  name: string;
  description: string;
  required: boolean;
  schema?: unknown;
}

/** One ordered procedural step with its constraints. */
export interface SkillStep {
  instruction: string;
  /** Constraints/guardrails that apply to this step; may be empty. */
  constraints: string[];
}

/** An example or test case demonstrating the skill, kept with the version. */
export interface SkillExample {
  title: string;
  input: unknown;
  expectedOutput: unknown;
}

/**
 * The full, versioned body of a skill. Every required field maps to a clause
 * of Requirement 16.1; the Skills_Engine rejects a version missing any of
 * them (Requirement 16.2). A new body is stored as a new version on every
 * confirmed update, and prior versions are retained for rollback
 * (Requirement 16.6).
 */
export interface SkillVersionBody {
  /** Purpose and applicability — why and when to use this skill. */
  purpose: string;
  applicability: string;
  /** Required context the skill needs before it can run. At least one entry. */
  requiredContext: string[];
  /** Input and output contracts. */
  inputContract: SkillIoField[];
  outputContract: SkillIoField[];
  /** Ordered steps with per-step constraints. At least one step. */
  steps: SkillStep[];
  /** Tools the skill requires (capability ids, binary names, etc.). */
  toolRequirements: string[];
  /** How failures are handled. */
  failureHandling: string;
  /** Verification criteria confirming the skill achieved its purpose. */
  verificationCriteria: string[];
  /** Examples and tests. At least one entry. */
  examples: SkillExample[];
}

/** A persisted immutable version of a skill. */
export interface SkillVersion extends SkillVersionBody {
  skillId: string;
  /** Monotonic version number starting at 1. */
  version: number;
  provenance: SkillProvenance;
  createdAt: string;
}

/** The current head of a skill plus its identity and scope. */
export interface Skill {
  id: string;
  name: string;
  scope: SkillScope;
  /** Project id when scope is `project`, workflow id when scope is `workflow`. */
  scopeRef?: string;
  /** The version number currently at head. */
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** A skill together with its current head version body. */
export interface SkillWithBody extends Skill {
  body: SkillVersion;
}

/**
 * A field-level diff between two skill version bodies, produced before an
 * overwrite so the user can review the change and confirm (Requirement 16.6).
 * Each entry names the changed field and carries the before/after values as
 * JSON-serializable snapshots.
 */
export interface SkillDiffEntry {
  field: keyof SkillVersionBody;
  before: unknown;
  after: unknown;
}

export interface SkillDiff {
  skillId: string;
  fromVersion: number;
  entries: SkillDiffEntry[];
}

/**
 * The outcome of a skill update request. `created` is the first version of a
 * new skill; `confirmation_required` means an existing skill would be
 * overwritten and the caller must re-issue with confirmation, carrying the
 * `diff` to show; `updated` means a confirmed overwrite stored a new version;
 * `unchanged` means the user declined (the existing skill is left intact) or
 * the submitted body was identical to head.
 */
export type SkillUpdateStatus =
  | 'created'
  | 'confirmation_required'
  | 'updated'
  | 'unchanged';

export interface SkillUpdateResult {
  skillId: string;
  status: SkillUpdateStatus;
  /** The version at head after the operation. */
  version: number;
  /** Present when status is `confirmation_required`. */
  diff?: SkillDiff;
}

/**
 * An installed agent's declared instruction format, used to decide whether a
 * skill can be exported to it. Agent-independence means the Skills_Engine does
 * not know about specific agents; the caller supplies the installed targets.
 */
export interface AgentInstructionTarget {
  agentId: string;
  /** The instruction format the agent consumes, e.g. 'markdown', 'json'. */
  format: SkillExportFormat;
}

/** The instruction formats the Skills_Engine can render a skill into. */
export type SkillExportFormat = 'markdown' | 'json';

/**
 * The outcome of exporting a skill to a target agent. `exported` carries the
 * rendered instruction text; `incompatible` reports that no compatible
 * instruction format exists for the target (Requirement 16.5).
 */
export type SkillExportResult =
  | {
      readonly status: 'exported';
      readonly agentId: string;
      readonly format: SkillExportFormat;
      readonly content: string;
    }
  | { readonly status: 'incompatible'; readonly agentId: string };

// ---- Learned skill bindings and invoice automation ----

export type SkillBindingStatus = 'active' | 'disabled';

/** A normalized external signal that can select a learned skill. */
export interface SkillTrigger {
  kind: 'vendor';
  key: string;
  aliases: string[];
}

export type InvoiceFieldNormalization =
  | 'text'
  | 'identifier'
  | 'amount'
  | 'date';

export interface InvoiceTemplateField {
  name: string;
  labels: string[];
  required: boolean;
  normalization: InvoiceFieldNormalization;
  /** Optional regular expression supplied by the generated template. */
  pattern?: string | undefined;
}

export type InvoiceLineItemField =
  | 'sku'
  | 'description'
  | 'quantity'
  | 'unitPrice'
  | 'amount';

export interface InvoiceLineItemColumn {
  field: InvoiceLineItemField;
  labels: string[];
  required: boolean;
}

/** Declarative mappings learned from a vendor invoice; never executable code. */
export interface InvoiceExtractionTemplate {
  fields: InvoiceTemplateField[];
  lineItems?: {
    columns: InvoiceLineItemColumn[];
    rowPattern?: string | undefined;
  } | undefined;
}

export interface SkillBinding {
  id: string;
  skillId: string;
  trigger: SkillTrigger;
  extractionTemplate: InvoiceExtractionTemplate;
  status: SkillBindingStatus;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type SkillUsageOutcome = 'pending' | 'completed' | 'failed' | 'skipped';

/** One application attempt, pinned to the immutable version that was used. */
export interface SkillUsage {
  id: string;
  bindingId?: string;
  taskId?: string;
  skillId: string;
  skillVersion: number;
  triggerKey: string;
  outcome: SkillUsageOutcome;
  startedAt: string;
  completedAt?: string;
}

/** Untrusted agent output accepted only after validation by SkillDraftSchema. */
export interface SkillDraft {
  vendorId: string;
  vendorAliases: string[];
  skill: {
    name: string;
    scope: SkillScope;
    scopeRef?: string;
    body: SkillVersionBody;
  };
  extractionTemplate: InvoiceExtractionTemplate;
}

export interface InvoiceExtractedField {
  name: string;
  value?: string | number;
  rawValue?: string;
  status: 'extracted' | 'missing' | 'ambiguous';
  confidence: number;
}

export interface InvoiceLineItem {
  sku?: string;
  description: string;
  quantity?: number;
  unitPrice?: number;
  amount?: number;
}

export interface InvoiceExtractionResult {
  fields: InvoiceExtractedField[];
  lineItems: InvoiceLineItem[];
  missingFields: string[];
  ambiguousFields: string[];
}

export interface PurchaseOrder {
  id: string;
  vendorId: string;
  poNumber: string;
  taxId?: string;
  currency: string;
  total: number;
  lineItems: InvoiceLineItem[];
}

export interface PurchaseOrderDiscrepancy {
  field: string;
  invoiceValue?: string | number;
  purchaseOrderValue?: string | number;
  detail: string;
}

export interface PurchaseOrderMatch {
  status: 'matched' | 'mismatch' | 'unavailable';
  purchaseOrderId?: string;
  discrepancies: PurchaseOrderDiscrepancy[];
  amountTolerance: number;
}

// ---------------------------------------------------------------------------
// External-flow transparency and data control (Requirement 21, cross-cutting)
// ---------------------------------------------------------------------------
//
// Conductor is local-first: all user data stays on the machine and leaves it
// only through an external data flow the user has explicitly consented to
// (Requirement 21.5). This section fixes the durable contracts that make that
// visible and controllable:
//
//  * `DataControlSettings` are the user-configurable knobs (Requirement 21.2):
//    how long stored data is retained, whether indexing and synchronization are
//    enabled, and (implicitly) the consent gate that governs external flows.
//  * `ExternalFlowIndicator` is the redacted event the UI renders within 500 ms
//    of an external transmission being initiated (Requirement 21.1); it names
//    the target provider and states that data is leaving the machine. It never
//    carries the transmitted payload.
//  * `ExternalFlowConsent` records a user-approved external flow (Requirement
//    21.4/21.5); a transmission to a provider the user has not consented to is
//    blocked.

/**
 * User-configurable data-control settings (Requirement 21.2). Defaults are
 * local-first: a finite retention window, indexing on (local only), and
 * external synchronization OFF until the user turns it on. Persisted through
 * the SettingsService under the `data.*` preference namespace.
 */
export interface DataControlSettings {
  /**
   * How long stored data is retained, in days. A value of 0 means "retain
   * indefinitely" (no automatic expiry). Never negative.
   */
  retentionDays: number;
  /** Whether source indexing and automatic knowledge retrieval are enabled. */
  indexingEnabled: boolean;
  /**
   * Whether external synchronization is enabled. OFF by default — local-first
   * means data is not synchronized externally unless the user opts in.
   */
  syncEnabled: boolean;
}

/** The preference keys the data-control settings are persisted under. */
export const DATA_CONTROL_KEYS = {
  retentionDays: 'data.retentionDays',
  indexingEnabled: 'data.indexingEnabled',
  syncEnabled: 'data.syncEnabled',
} as const;

/** The local-first default data-control settings (Requirement 21.5). */
export const DEFAULT_DATA_CONTROL_SETTINGS: DataControlSettings = {
  retentionDays: 90,
  indexingEnabled: true,
  syncEnabled: false,
};

/**
 * The redacted indicator surfaced to the UI when information is sent to an
 * external model provider or service (Requirement 21.1). It identifies the
 * target provider and asserts that data is leaving the machine; it carries no
 * transmitted content and no secret value.
 */
export interface ExternalFlowIndicator {
  /** Correlation id for this specific transmission. */
  id: string;
  /** The external provider/service the data is being sent to. */
  provider: string;
  /** The egress target (host/service/endpoint label). */
  target: string;
  /** Always true — the indicator exists to state data is leaving the machine. */
  leavingMachine: true;
  /** When the transmission was initiated (ISO-8601 UTC). */
  initiatedAt: string;
}

/**
 * A user-approved external data flow (Requirement 21.4/21.5). The presence of a
 * matching, non-revoked consent is what lets a transmission to `provider`
 * proceed; its absence blocks the flow with a consent-required message.
 */
export interface ExternalFlowConsent {
  id: string;
  /** The external provider the consent authorizes transmission to. */
  provider: string;
  grantedAt: string;
  revokedAt?: string;
}

/**
 * The outcome of a deletion of stored data (Requirement 21.3). `removedCount`
 * is the number of rows removed; `confirmation` is the human-readable message
 * the UI displays to confirm the deletion completed.
 */
export interface DataDeletionResult {
  /** Local deletion succeeded; remote Mem0 cleanup is queued for retry. */
  memoryCleanupPending?: boolean;
  target: DataDeletionTarget;
  removedCount: number;
  confirmation: string;
}

/**
 * The categories of stored data a deletion can target (Requirement 21.3).
 * `all` removes every category below.
 */
export type DataDeletionTarget =
  | 'all'
  | 'tasks'
  | 'context_items'
  | 'ingested_items'
  | 'audit_events';

// ---------------------------------------------------------------------------
// Self-learning engine (Requirement 18, Milestone M8)
// ---------------------------------------------------------------------------
//
// The Self_Learning_Engine observes per-task outcomes and runs the improvement
// cycle: record outcomes → detect a candidate → evaluate it against prior
// comparable examples → classify it as a demonstrated improvement (vs mere
// correlation) → propose it for approval as exactly one of a skill / routing
// rule / memory / workflow version → track adopted improvements → roll back on
// a demonstrated regression. It never autonomously edits core executable code
// (Property 10): the only actions it takes on its own are recording,
// classifying, proposing, and — once an improvement is adopted — tracking and
// rolling back, all of which touch learned procedures/preferences, never code.

/** The minimum number of comparable prior examples required to classify a
 *  candidate as a demonstrated improvement (Requirement 18.2). */
export const MIN_IMPROVEMENT_EXAMPLES = 5;

/** The minimum number of subsequent comparable tasks that must regress before
 *  an adopted improvement is rolled back (Requirement 18.5). */
export const MIN_REGRESSION_TASKS = 3;

/** Whether a recorded task ultimately succeeded or failed. */
export type TaskOutcomeResult = 'success' | 'failure';

/**
 * A per-task outcome observation (Requirement 18.1). `comparabilityKey` groups
 * observations that describe "the same kind of task" so a candidate can be
 * evaluated against comparable prior examples; the engine treats observations
 * that share a key as comparable.
 */
export interface TaskOutcome {
  id: string;
  taskId: string;
  /** Groups comparable tasks (e.g. objective signature / workflow id). */
  comparabilityKey: string;
  result: TaskOutcomeResult;
  /** Wall-clock duration of the task in milliseconds. */
  durationMs: number;
  /** How many times the task (or its steps) failed before this outcome. */
  failureCount: number;
  /** How many retries were consumed. */
  retryCount: number;
  /** Verification criterion results recorded for the task. */
  verificationResults: TaskVerificationResult[];
  /** Tools/capabilities the task used. */
  toolUsage: string[];
  /** Any user feedback associated with the task. */
  userFeedback?: string;
  /**
   * The id of the adopted improvement that was active for this task, when any.
   * Used to attribute post-adoption outcomes for regression tracking (18.5).
   */
  improvementId?: string;
  recordedAt: string;
}

/** A single verification criterion result carried on a {@link TaskOutcome}. */
export interface TaskVerificationResult {
  criterion: string;
  passed: boolean;
}

/** The input a caller records when a task completes (Requirement 18.1). */
export interface RecordTaskOutcomeInput {
  taskId: string;
  comparabilityKey: string;
  result: TaskOutcomeResult;
  durationMs: number;
  failureCount: number;
  retryCount: number;
  verificationResults: TaskVerificationResult[];
  toolUsage: string[];
  userFeedback?: string;
  improvementId?: string;
}

/**
 * The kind of learned artifact a demonstrated improvement is proposed as. A
 * candidate is proposed as exactly one of these (Requirement 18.3); none of
 * them is core executable code (Property 10).
 */
export type ImprovementKind =
  | 'skill'
  | 'routing_rule'
  | 'memory'
  | 'workflow_version';

/**
 * A candidate improvement submitted for evaluation. It carries the artifact it
 * would adopt (as one of the four allowed kinds) and the comparability key of
 * the tasks it claims to improve.
 */
export interface ImprovementCandidate {
  /** The comparability key whose tasks this candidate claims to improve. */
  comparabilityKey: string;
  kind: ImprovementKind;
  /** Short human-readable summary of what the improvement is. */
  summary: string;
  /** The opaque artifact payload to adopt (skill body, rule, memory, ...). */
  payload: unknown;
}

/**
 * Aggregate performance of a set of comparable task outcomes: the failure rate
 * in [0, 1] and the mean duration in milliseconds. Used both as the baseline a
 * candidate is evaluated against and as the post-adoption measurement.
 */
export interface PerformanceBaseline {
  /** Number of observations the metrics are computed from. */
  sampleSize: number;
  /** Fraction of observations that failed, in [0, 1]. */
  failureRate: number;
  /** Mean duration in milliseconds across the observations. */
  meanDurationMs: number;
}

/** Why a candidate was not classified as a demonstrated improvement. */
export type CandidateRejectionReason =
  | 'insufficient_examples' // fewer than MIN_IMPROVEMENT_EXAMPLES comparable priors
  | 'no_measurable_improvement'; // neither failure rate nor duration fell

/**
 * The outcome of evaluating a candidate (Requirement 18.2). `demonstrated`
 * means it produced a measurable reduction in failure rate or duration across
 * at least MIN_IMPROVEMENT_EXAMPLES comparable prior examples and a proposal
 * was created; `correlation` means it was withheld (it is not surfaced for
 * approval), with `reason` explaining why.
 */
export type CandidateEvaluation =
  | {
      readonly classification: 'demonstrated';
      readonly baseline: PerformanceBaseline;
      readonly projected: PerformanceBaseline;
      readonly proposal: ImprovementProposal;
    }
  | {
      readonly classification: 'correlation';
      readonly reason: CandidateRejectionReason;
      readonly baseline: PerformanceBaseline;
    };

/** The lifecycle status of an improvement proposal. */
export type ImprovementStatus =
  | 'proposed' // demonstrated and awaiting the user's approval decision
  | 'approved' // the user approved it; it is now adopted and tracked
  | 'rejected' // the user rejected it; discarded, never adopted
  | 'rolled_back'; // adopted then rolled back after a demonstrated regression

/**
 * A demonstrated improvement presented to the user for approval
 * (Requirement 18.3). It records the baseline it was measured against and the
 * projected post-adoption metrics so the user sees why it was proposed. No
 * adoption action is taken until the user approves (18.3); a rejection
 * discards it (18.4).
 */
export interface ImprovementProposal {
  id: string;
  comparabilityKey: string;
  kind: ImprovementKind;
  summary: string;
  payload: unknown;
  status: ImprovementStatus;
  baseline: PerformanceBaseline;
  projected: PerformanceBaseline;
  createdAt: string;
  /** When the user approved/rejected it. */
  resolvedAt?: string;
  /** When an adopted improvement was rolled back. */
  rolledBackAt?: string;
}

/**
 * The outcome of checking an adopted improvement for a regression
 * (Requirement 18.5). `rolled_back` means at least MIN_REGRESSION_TASKS
 * subsequent comparable tasks regressed relative to the pre-adoption baseline
 * and the improvement was rolled back (the user is notified via an audit
 * event); `monitoring` means not enough subsequent comparable tasks exist yet;
 * `healthy` means the subsequent tasks did not regress.
 */
export type RegressionCheckResult =
  | {
      readonly status: 'rolled_back';
      readonly improvementId: string;
      readonly baseline: PerformanceBaseline;
      readonly observed: PerformanceBaseline;
    }
  | {
      readonly status: 'monitoring';
      readonly improvementId: string;
      readonly observedCount: number;
    }
  | {
      readonly status: 'healthy';
      readonly improvementId: string;
      readonly observed: PerformanceBaseline;
    };

// ---------------------------------------------------------------------------
// Proactive assistant (Requirement 19, Milestone M8)
// ---------------------------------------------------------------------------
//
// The Proactive_Assistant watches authorized context signals and suggests
// useful actions the user stays in control of. Conductor's proactive principle
// is "suggest first, auto-execute only when explicitly permitted": every
// generated suggestion carries the triggering context, the proposed action,
// and a human-readable explanation (19.1); it is surfaced non-blocking through
// the configured channel, dismissible and non-modal by default (19.2/19.3); it
// auto-executes ONLY when the user has explicitly configured the action as a
// low-risk auto-execute action within granted permissions, recording an audit
// entry (19.4); otherwise it is suggest-only and never executes without
// explicit confirmation (19.5); monitoring is limited to authorized sources
// (19.6); and any external side effect requires explicit authorization, the
// suggestion staying unexecuted until authorization is granted or it is
// dismissed (19.7).

/**
 * The kinds of context signal that can trigger a suggestion (Requirement 19.1).
 * Each maps to one of the enumerated triggers: an approaching deadline, an
 * email that needs a reply, a task that was interrupted, a workflow that is
 * due, a document that changed, or a step that repeatedly fails.
 */
export type SuggestionTriggerKind =
  | 'deadline_approaching'
  | 'email_awaiting_reply'
  | 'task_interrupted'
  | 'workflow_due'
  | 'document_changed'
  | 'repeated_step_failure';

/**
 * The triggering context of a suggestion (Requirement 19.1). `kind` names the
 * signal; `sourceId` identifies the authorized source it came from so the
 * assistant can enforce the authorized-sources limit (19.6); `summary` is a
 * human-readable description of what was observed; `observedAt` is when.
 */
export interface SuggestionTrigger {
  kind: SuggestionTriggerKind;
  /** The authorized source the signal was observed from (connector id, etc.). */
  sourceId: string;
  /** Human-readable description of the observed triggering context. */
  summary: string;
  observedAt: string;
}

/**
 * The action a suggestion proposes (Requirement 19.1). `kind` is a stable
 * identifier the user's auto-execute configuration matches against; `summary`
 * describes it in human terms; `externalSideEffect` marks an action that would
 * transmit or act outside the machine, which always requires explicit
 * authorization before execution (Requirement 19.7); `permissionRequirements`
 * are the permissions exercising it needs, checked against the subject's grants
 * before any auto-execution (Requirement 19.4).
 */
export interface SuggestionAction {
  /** Stable identifier matched against auto-execute configuration. */
  kind: string;
  /** Human-readable description of the proposed action. */
  summary: string;
  /** Whether executing the action would create an external side effect. */
  externalSideEffect: boolean;
  /** Permissions exercising the action requires; empty when none. */
  permissionRequirements: PermissionRequirement[];
  /** Opaque action parameters the executor interprets. */
  payload?: unknown;
}

/**
 * The lifecycle status of a suggestion.
 *  - `suggested`       — surfaced to the user, awaiting a decision.
 *  - `auto_executed`   — auto-run because it matched an explicit low-risk
 *                        auto-execute rule within granted permissions (19.4).
 *  - `awaiting_authorization` — retained unexecuted because it would create an
 *                        external side effect and authorization has not been
 *                        granted (19.7).
 *  - `confirmed`       — the user confirmed; the action may now execute (19.5).
 *  - `dismissed`       — the user dismissed it; it will not execute.
 */
export type SuggestionStatus =
  | 'suggested'
  | 'auto_executed'
  | 'awaiting_authorization'
  | 'confirmed'
  | 'dismissed';

/**
 * A generated suggestion (Requirement 19.1). It always carries its triggering
 * context, the proposed action, and the human-readable explanation of why it
 * was suggested. `status` tracks its lifecycle; `subject` is the agent or
 * workflow whose permissions an auto-execution would be checked against.
 */
export interface Suggestion {
  id: string;
  trigger: SuggestionTrigger;
  action: SuggestionAction;
  /** Why the suggestion was made, in human-readable terms (Requirement 19.1). */
  explanation: string;
  status: SuggestionStatus;
  createdAt: string;
  /** When the suggestion was auto-executed, confirmed, or dismissed. */
  resolvedAt?: string;
}

/**
 * An explicit user configuration marking an action kind as a low-risk
 * auto-execute action (Requirement 19.4). The assistant auto-executes a
 * suggestion ONLY when a matching, enabled rule exists AND the subject holds
 * the permissions the action requires AND the action creates no external side
 * effect. A rule is a deliberate, inspectable opt-in; without one, an action is
 * suggest-only (Requirement 19.5).
 */
export interface AutoExecuteRule {
  id: string;
  /** The {@link SuggestionAction.kind} this rule authorizes for auto-execute. */
  actionKind: string;
  /** The subject whose permissions an auto-execution is checked against. */
  subjectType: 'agent' | 'workflow';
  subjectId: string;
  /** Whether the rule is currently active; disabled rules never auto-execute. */
  enabled: boolean;
  createdAt: string;
}

/**
 * How a generated suggestion was handled at generation time (Requirement 19.4,
 * 19.5, 19.7). `auto_executed` means it matched an explicit low-risk rule and
 * ran; `suggested` means it was surfaced suggest-only and awaits confirmation;
 * `awaiting_authorization` means it would create an external side effect and is
 * retained unexecuted until authorization is granted or it is dismissed.
 */
export type SuggestionDisposition =
  | 'auto_executed'
  | 'suggested'
  | 'awaiting_authorization';

/** The outcome of generating a suggestion. */
export interface SuggestionGenerationResult {
  suggestion: Suggestion;
  disposition: SuggestionDisposition;
}

/** What deleting a project (workspace) removed. The project's folder on disk is never touched. */
export interface ProjectDeletionResult {
  /** Local deletion succeeded; remote Mem0 cleanup is queued for retry. */
  memoryCleanupPending?: boolean;
  workspaceId: string;
  removedThreads: number;
  removedTasks: number;
  removedConnectors: number;
  removedOutputs: number;
  /** The project selected afterwards, if any remain. */
  activeWorkspaceId: string | null;
}

/** What deleting one conversation thread removed. Project files are never touched. */
export interface ThreadDeletionResult {
  /** Local deletion succeeded; remote Mem0 cleanup is queued for retry. */
  memoryCleanupPending?: boolean;
  threadId: string;
  workspaceId: string;
  removedTasks: number;
  removedOutputs: number;
}
