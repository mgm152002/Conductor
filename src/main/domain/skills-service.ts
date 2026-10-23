import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type {
  AgentInstructionTarget,
  InvoiceExtractionTemplate,
  Skill,
  SkillBinding,
  SkillBindingStatus,
  SkillDiff,
  SkillDiffEntry,
  SkillExportResult,
  SkillExportFormat,
  SkillIoField,
  SkillProvenance,
  SkillScope,
  SkillStep,
  SkillTrigger,
  SkillUpdateResult,
  SkillUsage,
  SkillUsageOutcome,
  SkillVersion,
  SkillVersionBody,
  SkillWithBody,
} from '@shared/domain';
import { InvoiceExtractionTemplateSchema } from '@shared/skill-draft';
import type { AuditLog } from './audit-log';

// The Skills_Engine owns Requirement 16: versioned, agent-independent units of
// procedural knowledge.
//
//  - A skill is represented with every required field (16.1); a submission
//    missing any of them is rejected with a field-identifying error (16.2).
//  - Skills live at global / project / workflow scope (16.3).
//  - Skills export to a target agent's compatible instruction format (16.4) and
//    report incompatibility when no compatible format exists (16.5).
//  - An update that would overwrite an existing skill is NEVER silent: the
//    service returns a diff and requires explicit confirmation; on confirmation
//    it stores a new version while retaining prior versions for rollback (16.6).
//  - Declining an update leaves the existing skill unchanged (16.7).
//
// Persistence follows the established two-table versioning shape (migration 6):
// `skills` holds identity + a head pointer (current_version), `skill_versions`
// is the append-only immutable history. A rollback repoints current_version at
// an older version row without mutating any version body.

/** The scope-ref sentinel for global skills (mirrors the preferences table). */
const GLOBAL_SCOPE_REF = '';

/**
 * Raised when a skill create/update submission is missing one or more of the
 * required fields from Requirement 16.1. `missingFields` identifies exactly
 * which fields were absent or empty (Requirement 16.2).
 */
export class SkillValidationError extends Error {
  constructor(readonly missingFields: string[]) {
    super(
      `Skill is missing required field(s): ${missingFields.join(', ')}`,
    );
    this.name = 'SkillValidationError';
  }
}

/** Raised when an operation targets a skill id or version that does not exist. */
export class SkillNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillNotFoundError';
  }
}

/** Raised when a binding id does not exist. */
export class SkillBindingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillBindingNotFoundError';
  }
}

/** Raised when a usage id does not exist. */
export class SkillUsageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillUsageNotFoundError';
  }
}

/**
 * Raised when a binding or usage submission is invalid. `issues` names every
 * offending field so callers can surface a precise correction.
 */
export class SkillBindingValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid skill binding: ${issues.join('; ')}`);
    this.name = 'SkillBindingValidationError';
  }
}

export interface SkillBindingFilter {
  skillId?: string;
  status?: SkillBindingStatus;
}

/** A trigger supplied by a caller; aliases are optional and normalized. */
export interface SkillTriggerInput {
  kind: 'vendor';
  key: string;
  aliases?: string[];
}

export interface SaveSkillBindingInput {
  /** Present to update an existing binding; omitted to create one. */
  bindingId?: string;
  /** Alias for `bindingId` for callers that already hold a binding object. */
  id?: string;
  skillId: string;
  trigger: SkillTriggerInput;
  extractionTemplate: InvoiceExtractionTemplate;
  status?: SkillBindingStatus;
  /** Audit actor, e.g. 'user' or 'orchestrator'. */
  actor?: string;
  /** Task that produced the binding, retained in the audit trail. */
  sourceTaskId?: string;
}

export interface SetSkillBindingStatusInput {
  bindingId: string;
  status: SkillBindingStatus;
  actor?: string;
  sourceTaskId?: string;
}

export interface RemoveSkillBindingInput {
  bindingId: string;
  actor?: string;
  sourceTaskId?: string;
}

export interface MatchSkillBindingInput extends SkillTriggerInput {}

/** The active binding selected for an incoming trigger, resolved to its head. */
export interface MatchedSkillBinding {
  binding: SkillBinding;
  skill: SkillWithBody;
  /** The normalized key or alias that produced the match. */
  matchedKey: string;
}

export interface RecordSkillUsageInput {
  bindingId?: string;
  taskId?: string;
  /** Defaults to the binding's skill when a binding is supplied. */
  skillId?: string;
  /** Defaults to the skill's current head version. */
  skillVersion?: number;
  /** Defaults to the binding's trigger key when a binding is supplied. */
  triggerKey?: string;
  outcome?: SkillUsageOutcome;
  startedAt?: string;
  actor?: string;
}

export interface FinishSkillUsageOptions {
  completedAt?: string;
  actor?: string;
  /** Optional human-readable detail retained in the audit event. */
  detail?: string;
}

export interface SkillUsageFilter {
  skillId?: string;
  bindingId?: string;
  taskId?: string;
  limit?: number;
}

export interface SkillIdentity {
  name: string;
  scope: SkillScope;
  /** Required for project/workflow scope; ignored for global. */
  scopeRef?: string;
}

export interface UpsertSkillInput extends SkillIdentity {
  body: SkillVersionBody;
  provenance: SkillProvenance;
  /**
   * Explicit confirmation to overwrite an existing skill with a new version.
   * When omitted/false and the skill already exists with a different body, the
   * service returns `confirmation_required` with a diff and changes nothing
   * (Requirement 16.6).
   */
  confirmed?: boolean;
}

interface SkillRow {
  id: string;
  name: string;
  scope: SkillScope;
  scope_ref: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface SkillVersionRow {
  skill_id: string;
  version: number;
  purpose: string;
  applicability: string;
  required_context: string;
  input_contract: string;
  output_contract: string;
  steps: string;
  tool_requirements: string;
  failure_handling: string;
  verification_criteria: string;
  examples: string;
  provenance_method: SkillProvenance['method'];
  provenance_source: string;
  created_at: string;
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    ...(row.scope_ref !== GLOBAL_SCOPE_REF ? { scopeRef: row.scope_ref } : {}),
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: SkillVersionRow): SkillVersion {
  return {
    skillId: row.skill_id,
    version: row.version,
    purpose: row.purpose,
    applicability: row.applicability,
    requiredContext: JSON.parse(row.required_context) as string[],
    inputContract: JSON.parse(row.input_contract) as SkillIoField[],
    outputContract: JSON.parse(row.output_contract) as SkillIoField[],
    steps: JSON.parse(row.steps) as SkillStep[],
    toolRequirements: JSON.parse(row.tool_requirements) as string[],
    failureHandling: row.failure_handling,
    verificationCriteria: JSON.parse(row.verification_criteria) as string[],
    examples: JSON.parse(row.examples) as SkillVersion['examples'],
    provenance: { method: row.provenance_method, source: row.provenance_source },
    createdAt: row.created_at,
  };
}

interface SkillBindingRow {
  id: string;
  skill_id: string;
  trigger_type: 'vendor';
  trigger_key: string;
  trigger_aliases: string;
  extraction_template: string;
  status: SkillBindingStatus;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SkillUsageRow {
  id: string;
  binding_id: string | null;
  task_id: string | null;
  skill_id: string;
  skill_version: number;
  trigger_key: string;
  outcome: SkillUsageOutcome;
  started_at: string;
  completed_at: string | null;
}

function rowToBinding(row: SkillBindingRow): SkillBinding {
  return {
    id: row.id,
    skillId: row.skill_id,
    trigger: {
      kind: row.trigger_type,
      key: row.trigger_key,
      aliases: JSON.parse(row.trigger_aliases) as string[],
    },
    extractionTemplate: JSON.parse(
      row.extraction_template,
    ) as InvoiceExtractionTemplate,
    status: row.status,
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUsage(row: SkillUsageRow): SkillUsage {
  return {
    id: row.id,
    ...(row.binding_id !== null ? { bindingId: row.binding_id } : {}),
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    triggerKey: row.trigger_key,
    outcome: row.outcome,
    startedAt: row.started_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

const MAX_TRIGGER_LENGTH = 255;
const MAX_TRIGGER_ALIASES = 32;

/**
 * Deterministic vendor-key normalization shared with trigger recognition:
 * Unicode NFKC, lower case, punctuation folded to spaces, whitespace collapsed.
 * Callers that recognize incoming invoices must use this same function so a
 * saved binding and a later invoice resolve to the identical key.
 */
export function normalizeSkillTriggerKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The required fields of a skill body and how to tell whether each is present.
 * Used to produce the precise `missingFields` list for Requirement 16.2.
 */
const REQUIRED_FIELD_CHECKS: ReadonlyArray<{
  field: string;
  present: (body: SkillVersionBody) => boolean;
}> = [
  { field: 'purpose', present: (b) => isNonEmptyString(b.purpose) },
  { field: 'applicability', present: (b) => isNonEmptyString(b.applicability) },
  {
    field: 'requiredContext',
    present: (b) => isNonEmptyStringArray(b.requiredContext),
  },
  { field: 'inputContract', present: (b) => isIoFieldArray(b.inputContract) },
  { field: 'outputContract', present: (b) => isIoFieldArray(b.outputContract) },
  { field: 'steps', present: (b) => isStepArray(b.steps) },
  {
    field: 'toolRequirements',
    present: (b) => isNonEmptyStringArray(b.toolRequirements),
  },
  {
    field: 'failureHandling',
    present: (b) => isNonEmptyString(b.failureHandling),
  },
  {
    field: 'verificationCriteria',
    present: (b) => isNonEmptyStringArray(b.verificationCriteria),
  },
  {
    field: 'examples',
    present: (b) => Array.isArray(b.examples) && b.examples.length > 0,
  },
];

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isNonEmptyString(entry))
  );
}

function isIoFieldArray(value: unknown): boolean {
  // The contract may legitimately be empty (a skill with no inputs/outputs),
  // but each present entry must be a well-formed field.
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        isNonEmptyString((entry as SkillIoField).name) &&
        typeof (entry as SkillIoField).description === 'string' &&
        typeof (entry as SkillIoField).required === 'boolean',
    )
  );
}

function isStepArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        isNonEmptyString((entry as SkillStep).instruction) &&
        Array.isArray((entry as SkillStep).constraints),
    )
  );
}

/** The ordered set of SkillVersionBody fields compared when producing a diff. */
const BODY_FIELDS: ReadonlyArray<keyof SkillVersionBody> = [
  'purpose',
  'applicability',
  'requiredContext',
  'inputContract',
  'outputContract',
  'steps',
  'toolRequirements',
  'failureHandling',
  'verificationCriteria',
  'examples',
];

/** Stable structural equality via JSON, sufficient for these plain-data bodies. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class SkillsService {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
    /** Clock seam so tests can control timestamps. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Create a new skill or update an existing one. On create, the first version
   * is stored immediately. On update of an existing skill:
   *  - if the submitted body equals head, returns `unchanged`;
   *  - if it differs and `confirmed` is not true, returns `confirmation_required`
   *    with a diff and changes nothing (Requirement 16.6/16.7);
   *  - if it differs and `confirmed` is true, stores a new version and advances
   *    the head pointer, retaining prior versions for rollback.
   *
   * Validates the body against every required field first and rejects with a
   * field-identifying error if any is missing (Requirement 16.2).
   */
  upsert(input: UpsertSkillInput): SkillUpdateResult {
    this.validateBody(input.body);

    const scopeRef = this.resolveScopeRef(input);
    const existing = this.findByIdentity(input.name, input.scope, scopeRef);

    if (existing === undefined) {
      return this.createSkill(input, scopeRef);
    }

    const head = this.getVersion(existing.id, existing.current_version);
    if (head !== undefined && deepEqual(stripBody(head), input.body)) {
      return {
        skillId: existing.id,
        status: 'unchanged',
        version: existing.current_version,
      };
    }

    if (input.confirmed !== true) {
      // Never overwrite silently: report the diff and require confirmation.
      const diff = this.buildDiff(
        existing.id,
        existing.current_version,
        head === undefined ? emptyBody() : stripBody(head),
        input.body,
      );
      this.audit.append({
        actor: provenanceActor(input.provenance),
        action: 'skill_update_confirmation_required',
        target: existing.id,
        redactedPayload: {
          skillId: existing.id,
          fromVersion: existing.current_version,
          changedFields: diff.entries.map((e) => e.field),
        },
      });
      return {
        skillId: existing.id,
        status: 'confirmation_required',
        version: existing.current_version,
        diff,
      };
    }

    return this.storeNewVersion(existing, input);
  }

  /** Validate a body against the required-field set (Requirement 16.1/16.2). */
  validateBody(body: SkillVersionBody): void {
    const missing = REQUIRED_FIELD_CHECKS.filter(
      (check) => !check.present(body),
    ).map((check) => check.field);
    if (missing.length > 0) {
      throw new SkillValidationError(missing);
    }
  }

  // ---- Reads ----

  get(skillId: string): SkillWithBody | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM skills WHERE id = ?')
      .get(skillId) as SkillRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    const version = this.getVersion(row.id, row.current_version);
    if (version === undefined) {
      return undefined;
    }
    return { ...rowToSkill(row), body: version };
  }

  /** All skills at a scope (and scope ref), ordered by name. */
  list(scope?: SkillScope, scopeRef?: string): Skill[] {
    if (scope === undefined) {
      const rows = this.store.db
        .prepare('SELECT * FROM skills ORDER BY name ASC, rowid ASC')
        .all() as SkillRow[];
      return rows.map(rowToSkill);
    }
    const ref = scope === 'global' ? GLOBAL_SCOPE_REF : (scopeRef ?? '');
    const rows = this.store.db
      .prepare(
        `SELECT * FROM skills WHERE scope = ? AND scope_ref = ?
         ORDER BY name ASC, rowid ASC`,
      )
      .all(scope, ref) as SkillRow[];
    return rows.map(rowToSkill);
  }

  /** A single immutable version body, or undefined when it does not exist. */
  getVersion(skillId: string, version: number): SkillVersion | undefined {
    const row = this.store.db
      .prepare(
        'SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?',
      )
      .get(skillId, version) as SkillVersionRow | undefined;
    return row === undefined ? undefined : rowToVersion(row);
  }

  /** All version numbers for a skill, ascending. */
  versions(skillId: string): number[] {
    const rows = this.store.db
      .prepare(
        'SELECT version FROM skill_versions WHERE skill_id = ? ORDER BY version ASC',
      )
      .all(skillId) as { version: number }[];
    return rows.map((r) => r.version);
  }

  // ---- Rollback ----

  /**
   * Roll back the skill head to an existing earlier (or any) version. The prior
   * version bodies are never mutated — rollback only repoints current_version —
   * so a rollback is itself reversible. Rejects an unknown skill or version.
   */
  rollback(skillId: string, toVersion: number): SkillWithBody {
    const skill = this.store.db
      .prepare('SELECT * FROM skills WHERE id = ?')
      .get(skillId) as SkillRow | undefined;
    if (skill === undefined) {
      throw new SkillNotFoundError(`Skill ${skillId} not found`);
    }
    const target = this.getVersion(skillId, toVersion);
    if (target === undefined) {
      throw new SkillNotFoundError(
        `Skill ${skillId} has no version ${toVersion}`,
      );
    }

    const updatedAt = new Date(this.now()).toISOString();
    this.store.db
      .prepare(
        'UPDATE skills SET current_version = ?, updated_at = ? WHERE id = ?',
      )
      .run(toVersion, updatedAt, skillId);

    this.audit.append({
      actor: 'user',
      action: 'skill_rolled_back',
      target: skillId,
      redactedPayload: { fromVersion: skill.current_version, toVersion },
    });

    return this.get(skillId)!;
  }

  // ---- Export ----

  /**
   * Export a skill to a target installed agent's instruction format. Where the
   * target declares a compatible format the skill is rendered to it
   * (Requirement 16.4); otherwise the result reports it cannot be exported
   * (Requirement 16.5). Agent-independence is preserved: the service does not
   * know about specific agents — the caller supplies the target's declared
   * format.
   */
  exportTo(skillId: string, target: AgentInstructionTarget): SkillExportResult {
    const skill = this.get(skillId);
    if (skill === undefined) {
      throw new SkillNotFoundError(`Skill ${skillId} not found`);
    }

    if (!SUPPORTED_FORMATS.has(target.format)) {
      this.audit.append({
        actor: 'orchestrator',
        action: 'skill_export_incompatible',
        target: skillId,
        redactedPayload: { agentId: target.agentId, format: target.format },
      });
      return { status: 'incompatible', agentId: target.agentId };
    }

    const content = this.render(skill, target.format);
    this.audit.append({
      actor: 'orchestrator',
      action: 'skill_exported',
      target: skillId,
      redactedPayload: { agentId: target.agentId, format: target.format },
    });
    return {
      status: 'exported',
      agentId: target.agentId,
      format: target.format,
      content,
    };
  }

  // ---- Bindings and usage ----
  //
  // A binding attaches a versioned skill to a normalized external trigger
  // (currently a vendor id) plus the declarative extraction template learned
  // for it. Bindings never store a version: they always resolve the skill's
  // current head, so a rollback immediately changes what new tasks apply
  // (Requirement 2.4). Usage rows, in contrast, pin the exact immutable version
  // that ran so history survives later edits (Requirement 2.3/5.1).

  /** Bindings, newest first, optionally filtered by skill and/or status. */
  listBindings(filter: SkillBindingFilter = {}): SkillBinding[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.skillId !== undefined) {
      clauses.push('skill_id = ?');
      params.push(filter.skillId);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.store.db
      .prepare(
        `SELECT * FROM skill_bindings ${where}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...params) as SkillBindingRow[];
    return rows.map(rowToBinding);
  }

  /**
   * Create or update a binding. The skill must exist (with a head version), the
   * trigger must normalize to a non-empty vendor key, the extraction template
   * must satisfy the shared schema, and no other binding may own the same
   * normalized key. Every mutation is transactional and audited.
   */
  saveBinding(input: SaveSkillBindingInput): SkillBinding {
    const skill = this.get(input.skillId);
    if (skill === undefined) {
      throw new SkillNotFoundError(`Skill ${input.skillId} not found`);
    }
    const trigger = this.normalizeTrigger(input.trigger);
    const extractionTemplate = this.validateExtractionTemplate(
      input.extractionTemplate,
    );
    const requestedId = input.bindingId ?? input.id;
    const existing =
      requestedId === undefined ? undefined : this.loadBinding(requestedId);
    if (requestedId !== undefined && existing === undefined) {
      throw new SkillBindingNotFoundError(
        `Skill binding ${requestedId} not found`,
      );
    }
    // Preserve an existing binding's status unless the caller changes it.
    const status = input.status ?? existing?.status ?? 'active';
    if (status !== 'active' && status !== 'disabled') {
      throw new SkillBindingValidationError(['status']);
    }

    const id = requestedId ?? randomUUID();
    const nowIso = new Date(this.now()).toISOString();

    this.store.transaction((tx) => {
      const conflict = tx.db
        .prepare(
          `SELECT * FROM skill_bindings
           WHERE trigger_type = ? AND trigger_key = ?`,
        )
        .get(trigger.kind, trigger.key) as SkillBindingRow | undefined;
      if (conflict !== undefined && conflict.id !== id) {
        throw new SkillBindingValidationError([
          `trigger.key: '${trigger.key}' is already bound to skill ${conflict.skill_id}`,
        ]);
      }

      if (existing === undefined) {
        tx.db
          .prepare(
            `INSERT INTO skill_bindings
               (id, skill_id, trigger_type, trigger_key, trigger_aliases,
                extraction_template, status, last_used_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            id,
            skill.id,
            trigger.kind,
            trigger.key,
            JSON.stringify(trigger.aliases),
            JSON.stringify(extractionTemplate),
            status,
            nowIso,
            nowIso,
          );
      } else {
        tx.db
          .prepare(
            `UPDATE skill_bindings
             SET skill_id = ?, trigger_type = ?, trigger_key = ?,
                 trigger_aliases = ?, extraction_template = ?, status = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
            skill.id,
            trigger.kind,
            trigger.key,
            JSON.stringify(trigger.aliases),
            JSON.stringify(extractionTemplate),
            status,
            nowIso,
            id,
          );
      }

      this.audit.append({
        actor: input.actor ?? 'user',
        action:
          existing === undefined
            ? 'skill_binding_created'
            : 'skill_binding_updated',
        target: id,
        redactedPayload: {
          bindingId: id,
          skillId: skill.id,
          skillVersion: skill.currentVersion,
          triggerKey: trigger.key,
          aliases: trigger.aliases,
          status,
          sourceTaskId: input.sourceTaskId,
        },
      });
    });

    const binding = this.loadBinding(id);
    if (binding === undefined) {
      throw new SkillBindingNotFoundError(`Skill binding ${id} not found`);
    }
    return binding;
  }

  /** Enable or disable a binding; disabled bindings are never matched. */
  setBindingStatus(input: SetSkillBindingStatusInput): SkillBinding {
    const existing = this.loadBinding(input.bindingId);
    if (existing === undefined) {
      throw new SkillBindingNotFoundError(
        `Skill binding ${input.bindingId} not found`,
      );
    }
    if (input.status !== 'active' && input.status !== 'disabled') {
      throw new SkillBindingValidationError(['status']);
    }
    if (existing.status === input.status) {
      return existing;
    }

    const nowIso = new Date(this.now()).toISOString();
    this.store.transaction((tx) => {
      tx.db
        .prepare(
          'UPDATE skill_bindings SET status = ?, updated_at = ? WHERE id = ?',
        )
        .run(input.status, nowIso, input.bindingId);
      this.audit.append({
        actor: input.actor ?? 'user',
        action: 'skill_binding_status_changed',
        target: input.bindingId,
        redactedPayload: {
          bindingId: input.bindingId,
          skillId: existing.skillId,
          triggerKey: existing.trigger.key,
          from: existing.status,
          to: input.status,
          sourceTaskId: input.sourceTaskId,
        },
      });
    });

    const updated = this.loadBinding(input.bindingId);
    if (updated === undefined) {
      throw new SkillBindingNotFoundError(
        `Skill binding ${input.bindingId} not found`,
      );
    }
    return updated;
  }

  /**
   * Remove a binding. Historical usage rows are deliberately preserved: the
   * schema nulls their `binding_id` on delete rather than cascading.
   */
  removeBinding(input: RemoveSkillBindingInput | string): void {
    const bindingId = typeof input === 'string' ? input : input.bindingId;
    const actor = typeof input === 'string' ? undefined : input.actor;
    const sourceTaskId =
      typeof input === 'string' ? undefined : input.sourceTaskId;
    const existing = this.loadBinding(bindingId);
    if (existing === undefined) {
      throw new SkillBindingNotFoundError(
        `Skill binding ${bindingId} not found`,
      );
    }

    this.store.transaction((tx) => {
      tx.db
        .prepare('DELETE FROM skill_bindings WHERE id = ?')
        .run(bindingId);
      this.audit.append({
        actor: actor ?? 'user',
        action: 'skill_binding_removed',
        target: bindingId,
        redactedPayload: {
          bindingId,
          skillId: existing.skillId,
          triggerKey: existing.trigger.key,
          aliases: existing.trigger.aliases,
          sourceTaskId,
        },
      });
    });
  }

  /**
   * Select the active binding whose key or alias exactly matches the incoming
   * trigger. The longest matching key wins, with a deterministic tiebreaker.
   * The returned skill is the binding's current head, never a stored version.
   */
  matchBinding(
    input: MatchSkillBindingInput | string,
  ): MatchedSkillBinding | undefined {
    const triggerInput =
      typeof input === 'string'
        ? { kind: 'vendor' as const, key: input, aliases: [] }
        : input;
    const query = this.normalizeTrigger(triggerInput);
    const candidates = new Set<string>([query.key, ...query.aliases]);

    let best:
      | { binding: SkillBinding; matchedKey: string }
      | undefined;
    for (const binding of this.listBindings({ status: 'active' })) {
      const keys = [binding.trigger.key, ...binding.trigger.aliases];
      for (const key of keys) {
        if (!candidates.has(key)) {
          continue;
        }
        if (
          best === undefined ||
          key.length > best.matchedKey.length ||
          (key.length === best.matchedKey.length &&
            (binding.trigger.key < best.binding.trigger.key ||
              (binding.trigger.key === best.binding.trigger.key &&
                binding.id < best.binding.id)))
        ) {
          best = { binding, matchedKey: key };
        }
      }
    }

    if (best === undefined) {
      return undefined;
    }
    const skill = this.get(best.binding.skillId);
    if (skill === undefined) {
      return undefined;
    }
    return { binding: best.binding, skill, matchedKey: best.matchedKey };
  }

  /**
   * Record an application attempt. When a binding is supplied its skill and
   * trigger default from the binding, and the version defaults to the skill's
   * current head. A terminal outcome supplied here is also completed.
   */
  recordUsage(input: RecordSkillUsageInput): SkillUsage {
    const binding =
      input.bindingId === undefined
        ? undefined
        : this.loadBinding(input.bindingId);
    if (input.bindingId !== undefined && binding === undefined) {
      throw new SkillBindingNotFoundError(
        `Skill binding ${input.bindingId} not found`,
      );
    }

    const skillId = input.skillId ?? binding?.skillId;
    if (skillId === undefined || skillId === '') {
      throw new SkillBindingValidationError(['skillId']);
    }
    if (binding !== undefined && binding.skillId !== skillId) {
      throw new SkillBindingValidationError([
        'skillId: does not match the binding skill',
      ]);
    }

    const skill = this.get(skillId);
    if (skill === undefined) {
      throw new SkillNotFoundError(`Skill ${skillId} not found`);
    }
    const skillVersion = input.skillVersion ?? skill.currentVersion;
    if (this.getVersion(skillId, skillVersion) === undefined) {
      throw new SkillNotFoundError(
        `Skill ${skillId} has no version ${skillVersion}`,
      );
    }

    const rawTriggerKey = input.triggerKey ?? binding?.trigger.key;
    const triggerKey =
      rawTriggerKey === undefined
        ? undefined
        : normalizeSkillTriggerKey(rawTriggerKey);
    if (triggerKey === undefined || triggerKey === '') {
      throw new SkillBindingValidationError(['triggerKey']);
    }

    const outcome = input.outcome ?? 'pending';
    if (!USAGE_OUTCOMES.has(outcome)) {
      throw new SkillBindingValidationError(['outcome']);
    }
    const startedAt = input.startedAt ?? new Date(this.now()).toISOString();
    const completedAt =
      outcome === 'pending' ? null : new Date(this.now()).toISOString();
    const id = randomUUID();

    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `INSERT INTO skill_usages
             (id, binding_id, task_id, skill_id, skill_version, trigger_key,
              outcome, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          binding?.id ?? null,
          input.taskId ?? null,
          skillId,
          skillVersion,
          triggerKey,
          outcome,
          startedAt,
          completedAt,
        );
      if (binding !== undefined) {
        tx.db
          .prepare('UPDATE skill_bindings SET last_used_at = ? WHERE id = ?')
          .run(startedAt, binding.id);
      }
      this.audit.append({
        actor: input.actor ?? 'orchestrator',
        action: 'skill_usage_recorded',
        target: id,
        redactedPayload: {
          usageId: id,
          bindingId: binding?.id,
          taskId: input.taskId,
          skillId,
          skillVersion,
          triggerKey,
          outcome,
        },
      });
    });

    const usage = this.loadUsage(id);
    if (usage === undefined) {
      throw new SkillUsageNotFoundError(`Skill usage ${id} not found`);
    }
    return usage;
  }

  /** Finalize a usage row with its eventual outcome and completion time. */
  finishUsage(
    usageId: string,
    outcome: Exclude<SkillUsageOutcome, 'pending'>,
    options: FinishSkillUsageOptions = {},
  ): SkillUsage {
    const existing = this.loadUsage(usageId);
    if (existing === undefined) {
      throw new SkillUsageNotFoundError(`Skill usage ${usageId} not found`);
    }
    if (
      outcome !== 'completed' &&
      outcome !== 'failed' &&
      outcome !== 'skipped'
    ) {
      throw new SkillBindingValidationError(['outcome']);
    }

    const completedAt =
      options.completedAt ?? new Date(this.now()).toISOString();
    this.store.transaction((tx) => {
      tx.db
        .prepare(
          'UPDATE skill_usages SET outcome = ?, completed_at = ? WHERE id = ?',
        )
        .run(outcome, completedAt, usageId);
      if (existing.bindingId !== undefined) {
        tx.db
          .prepare('UPDATE skill_bindings SET last_used_at = ? WHERE id = ?')
          .run(completedAt, existing.bindingId);
      }
      this.audit.append({
        actor: options.actor ?? 'orchestrator',
        action: 'skill_usage_finished',
        target: usageId,
        redactedPayload: {
          usageId,
          bindingId: existing.bindingId,
          taskId: existing.taskId,
          skillId: existing.skillId,
          skillVersion: existing.skillVersion,
          triggerKey: existing.triggerKey,
          from: existing.outcome,
          outcome,
          detail: options.detail,
        },
      });
    });

    const usage = this.loadUsage(usageId);
    if (usage === undefined) {
      throw new SkillUsageNotFoundError(`Skill usage ${usageId} not found`);
    }
    return usage;
  }

  /** Usage history, newest first, bounded by `limit` (default 100, max 500). */
  listUsages(filter: SkillUsageFilter = {}): SkillUsage[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.skillId !== undefined) {
      clauses.push('skill_id = ?');
      params.push(filter.skillId);
    }
    if (filter.bindingId !== undefined) {
      clauses.push('binding_id = ?');
      params.push(filter.bindingId);
    }
    if (filter.taskId !== undefined) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const requested = filter.limit ?? 100;
    const limit = Math.min(500, Math.max(1, Math.trunc(requested)));
    const rows = this.store.db
      .prepare(
        `SELECT * FROM skill_usages ${where}
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as SkillUsageRow[];
    return rows.map(rowToUsage);
  }

  // ---- Internals ----

  private loadBinding(bindingId: string): SkillBinding | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM skill_bindings WHERE id = ?')
      .get(bindingId) as SkillBindingRow | undefined;
    return row === undefined ? undefined : rowToBinding(row);
  }

  private loadUsage(usageId: string): SkillUsage | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM skill_usages WHERE id = ?')
      .get(usageId) as SkillUsageRow | undefined;
    return row === undefined ? undefined : rowToUsage(row);
  }

  private normalizeTrigger(input: SkillTriggerInput): SkillTrigger {
    const issues: string[] = [];
    if (input === null || typeof input !== 'object' || input.kind !== 'vendor') {
      issues.push('trigger.kind');
    }
    if (!isNonEmptyString(input?.key)) {
      issues.push('trigger.key');
    }
    const rawAliases = input?.aliases;
    if (rawAliases !== undefined && !Array.isArray(rawAliases)) {
      issues.push('trigger.aliases');
    } else if (Array.isArray(rawAliases) && rawAliases.length > MAX_TRIGGER_ALIASES) {
      issues.push(`trigger.aliases: at most ${MAX_TRIGGER_ALIASES} aliases`);
    }
    if (issues.length > 0) {
      throw new SkillBindingValidationError(issues);
    }

    const key = normalizeSkillTriggerKey(input.key);
    if (key === '' || key.length > MAX_TRIGGER_LENGTH) {
      throw new SkillBindingValidationError(['trigger.key']);
    }

    const aliases: string[] = [];
    const seen = new Set<string>([key]);
    for (const [index, raw] of (rawAliases ?? []).entries()) {
      if (typeof raw !== 'string') {
        throw new SkillBindingValidationError([`trigger.aliases.${index}`]);
      }
      const alias = normalizeSkillTriggerKey(raw);
      if (alias === '' || alias.length > MAX_TRIGGER_LENGTH) {
        throw new SkillBindingValidationError([`trigger.aliases.${index}`]);
      }
      if (!seen.has(alias)) {
        seen.add(alias);
        aliases.push(alias);
      }
    }
    return { kind: 'vendor', key, aliases };
  }

  private validateExtractionTemplate(
    template: InvoiceExtractionTemplate,
  ): InvoiceExtractionTemplate {
    const parsed = InvoiceExtractionTemplateSchema.safeParse(template);
    if (!parsed.success) {
      throw new SkillBindingValidationError(
        parsed.error.issues.map((issue) => {
          const path = issue.path.join('.');
          return path === '' ? issue.message : `${path}: ${issue.message}`;
        }),
      );
    }
    return parsed.data;
  }

  private createSkill(
    input: UpsertSkillInput,
    scopeRef: string,
  ): SkillUpdateResult {
    const id = randomUUID();
    const nowIso = new Date(this.now()).toISOString();

    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `INSERT INTO skills
             (id, name, scope, scope_ref, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, input.name.trim(), input.scope, scopeRef, nowIso, nowIso);
      this.insertVersion(tx.db, id, 1, input.body, input.provenance, nowIso);
    });

    this.audit.append({
      actor: provenanceActor(input.provenance),
      action: 'skill_created',
      target: id,
      redactedPayload: {
        name: input.name.trim(),
        scope: input.scope,
        scopeRef: scopeRef === GLOBAL_SCOPE_REF ? undefined : scopeRef,
      },
    });

    return { skillId: id, status: 'created', version: 1 };
  }

  private storeNewVersion(
    existing: SkillRow,
    input: UpsertSkillInput,
  ): SkillUpdateResult {
    // Rollback only moves the head; retained later versions remain immutable.
    const latest = this.store.db.prepare(
      'SELECT MAX(version) AS version FROM skill_versions WHERE skill_id = ?',
    ).get(existing.id) as { version: number };
    const nextVersion = latest.version + 1;
    const nowIso = new Date(this.now()).toISOString();

    this.store.transaction((tx) => {
      this.insertVersion(
        tx.db,
        existing.id,
        nextVersion,
        input.body,
        input.provenance,
        nowIso,
      );
      tx.db
        .prepare(
          'UPDATE skills SET current_version = ?, updated_at = ? WHERE id = ?',
        )
        .run(nextVersion, nowIso, existing.id);
    });

    this.audit.append({
      actor: provenanceActor(input.provenance),
      action: 'skill_version_added',
      target: existing.id,
      redactedPayload: {
        fromVersion: existing.current_version,
        toVersion: nextVersion,
      },
    });

    return { skillId: existing.id, status: 'updated', version: nextVersion };
  }

  private insertVersion(
    db: Store['db'],
    skillId: string,
    version: number,
    body: SkillVersionBody,
    provenance: SkillProvenance,
    createdAt: string,
  ): void {
    db.prepare(
      `INSERT INTO skill_versions
         (skill_id, version, purpose, applicability, required_context,
          input_contract, output_contract, steps, tool_requirements,
          failure_handling, verification_criteria, examples,
          provenance_method, provenance_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      skillId,
      version,
      body.purpose,
      body.applicability,
      JSON.stringify(body.requiredContext),
      JSON.stringify(body.inputContract),
      JSON.stringify(body.outputContract),
      JSON.stringify(body.steps),
      JSON.stringify(body.toolRequirements),
      body.failureHandling,
      JSON.stringify(body.verificationCriteria),
      JSON.stringify(body.examples),
      provenance.method,
      provenance.source,
      createdAt,
    );
  }

  private findByIdentity(
    name: string,
    scope: SkillScope,
    scopeRef: string,
  ): SkillRow | undefined {
    return this.store.db
      .prepare(
        'SELECT * FROM skills WHERE name = ? AND scope = ? AND scope_ref = ?',
      )
      .get(name.trim(), scope, scopeRef) as SkillRow | undefined;
  }

  private resolveScopeRef(identity: SkillIdentity): string {
    if (identity.scope === 'global') {
      return GLOBAL_SCOPE_REF;
    }
    const ref = (identity.scopeRef ?? '').trim();
    if (ref === '') {
      throw new SkillValidationError(['scopeRef']);
    }
    return ref;
  }

  private buildDiff(
    skillId: string,
    fromVersion: number,
    before: SkillVersionBody,
    after: SkillVersionBody,
  ): SkillDiff {
    const entries: SkillDiffEntry[] = [];
    for (const field of BODY_FIELDS) {
      if (!deepEqual(before[field], after[field])) {
        entries.push({ field, before: before[field], after: after[field] });
      }
    }
    return { skillId, fromVersion, entries };
  }

  private render(skill: SkillWithBody, format: SkillExportFormat): string {
    const b = skill.body;
    if (format === 'json') {
      return JSON.stringify(
        {
          name: skill.name,
          scope: skill.scope,
          ...b,
          version: skill.currentVersion,
        },
        null,
        2,
      );
    }
    // markdown
    const lines: string[] = [];
    lines.push(`# ${skill.name}`);
    lines.push('');
    lines.push(`_Version ${skill.currentVersion} · scope: ${skill.scope}_`);
    lines.push('');
    lines.push('## Purpose');
    lines.push(b.purpose);
    lines.push('');
    lines.push('## Applicability');
    lines.push(b.applicability);
    lines.push('');
    lines.push('## Required context');
    for (const c of b.requiredContext) {
      lines.push(`- ${c}`);
    }
    lines.push('');
    for (const [heading, fields] of [
      ['Input contract', b.inputContract],
      ['Output contract', b.outputContract],
    ] as const) {
      lines.push(`## ${heading}`);
      if (fields.length === 0) lines.push('No fields required.');
      for (const field of fields) {
        lines.push(`- ${field.name}${field.required ? ' (required)' : ' (optional)'}: ${field.description}`);
        if (field.schema !== undefined) {
          lines.push('```json', JSON.stringify(field.schema, null, 2), '```');
        }
      }
      lines.push('');
    }
    lines.push('## Steps');
    b.steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step.instruction}`);
      for (const constraint of step.constraints) {
        lines.push(`   - constraint: ${constraint}`);
      }
    });
    lines.push('');
    lines.push('## Tool requirements');
    for (const t of b.toolRequirements) {
      lines.push(`- ${t}`);
    }
    lines.push('');
    lines.push('## Failure handling');
    lines.push(b.failureHandling);
    lines.push('');
    lines.push('## Verification criteria');
    for (const v of b.verificationCriteria) {
      lines.push(`- ${v}`);
    }
    lines.push('');
    lines.push('## Examples and tests');
    for (const example of b.examples) {
      lines.push(`### ${example.title}`);
      lines.push('Input:', '```json', JSON.stringify(example.input, null, 2), '```');
      lines.push('Expected output:', '```json', JSON.stringify(example.expectedOutput, null, 2), '```');
      lines.push('');
    }
    lines.push(`Provenance: ${b.provenance.method} (${b.provenance.source})`);
    return lines.join('\n');
  }
}

/** The instruction formats this engine can render. */
const SUPPORTED_FORMATS: ReadonlySet<SkillExportFormat> = new Set<SkillExportFormat>([
  'markdown',
  'json',
]);

/** Every persisted usage outcome, including the in-flight state. */
const USAGE_OUTCOMES: ReadonlySet<SkillUsageOutcome> = new Set<SkillUsageOutcome>([
  'pending',
  'completed',
  'failed',
  'skipped',
]);

/** Extract just the body fields of a persisted version (drop identity/meta). */
function stripBody(version: SkillVersion): SkillVersionBody {
  return {
    purpose: version.purpose,
    applicability: version.applicability,
    requiredContext: version.requiredContext,
    inputContract: version.inputContract,
    outputContract: version.outputContract,
    steps: version.steps,
    toolRequirements: version.toolRequirements,
    failureHandling: version.failureHandling,
    verificationCriteria: version.verificationCriteria,
    examples: version.examples,
  };
}

function emptyBody(): SkillVersionBody {
  return {
    purpose: '',
    applicability: '',
    requiredContext: [],
    inputContract: [],
    outputContract: [],
    steps: [],
    toolRequirements: [],
    failureHandling: '',
    verificationCriteria: [],
    examples: [],
  };
}

/** Map a skill's provenance to an audit actor string. */
function provenanceActor(provenance: SkillProvenance): string {
  switch (provenance.method) {
    case 'user_authored':
      return 'user';
    case 'agent_output':
      return provenance.source || 'agent';
    case 'inferred':
      return 'orchestrator';
  }
}
