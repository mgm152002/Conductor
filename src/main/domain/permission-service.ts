import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type {
  ApprovalRequest,
  ApprovalStatus,
  PermissionProfile,
  PermissionRequirement,
  PermissionRequirementKind,
} from '@shared/domain';
import type { AuditLog } from './audit-log';

// The Permission_Service owns three concerns from Requirement 9:
//
//  1. Permission profiles (read_only, assisted_execution, trusted_automation)
//     granted to a subject — an agent (adapterId) or a workflow (workflowId) —
//     scoped (per requirement kind / scope string) and revocable.
//  2. The Approval_Request lifecycle: pending -> approved | denied | expired,
//     with a 24-hour timeout that leaves the task in WAITING_FOR_APPROVAL, and
//     a permission re-check on approval.
//  3. Revocation that cancels dependent in-flight actions and blocks any
//     subsequent action depending on the revoked permission.
//
// Every privileged operation appends a redacted Audit_Event via AuditLog.

/** The approval timeout from Requirement 9.5. */
export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type PermissionSubjectType = 'agent' | 'workflow';

export interface PermissionSubject {
  type: PermissionSubjectType;
  id: string;
}

/**
 * Requirement kinds that are "consequential" — a destructive, external, or
 * financial effect, or a mutation. Under assisted_execution these always need
 * an approval; under read_only they are never permitted.
 */
const CONSEQUENTIAL_KINDS: ReadonlySet<PermissionRequirementKind> = new Set([
  'filesystem_write',
  'command_exec',
  'external_comm',
  'financial',
  'destructive',
]);

/**
 * Per-profile base policy: whether a requirement kind is permitted at all, and
 * whether exercising it requires an approval first.
 */
function policyFor(
  profile: PermissionProfile,
  kind: PermissionRequirementKind,
): { permitted: boolean; requiresApproval: boolean } {
  const consequential = CONSEQUENTIAL_KINDS.has(kind);
  switch (profile) {
    case 'read_only':
      // Only non-consequential reads are permitted; everything else is denied.
      return { permitted: !consequential, requiresApproval: false };
    case 'assisted_execution':
      // Everything is permitted, but consequential actions require approval.
      return { permitted: true, requiresApproval: consequential };
    case 'trusted_automation':
      // Everything is permitted without per-action approval.
      return { permitted: true, requiresApproval: false };
  }
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

interface GrantRow {
  id: string;
  subject_type: PermissionSubjectType;
  subject_id: string;
  profile: PermissionProfile;
  requirement_kind: PermissionRequirementKind | null;
  scope: string | null;
  granted_at: string;
  revoked_at: string | null;
}

interface ApprovalRow {
  id: string;
  task_id: string;
  step_id: string | null;
  subject_type: PermissionSubjectType;
  subject_id: string;
  summary: string;
  requirements: string;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

export interface PermissionGrant {
  id: string;
  subject: PermissionSubject;
  profile: PermissionProfile;
  requirementKind?: PermissionRequirementKind;
  scope?: string;
  grantedAt: string;
  revokedAt?: string;
}

/**
 * A handle to an in-flight action that depends on a permission. The service
 * calls `cancel` when a grant the action depends on is revoked. Callers
 * register their running work so revocation can tear it down.
 */
export interface InFlightAction {
  subject: PermissionSubject;
  requirement: PermissionRequirement;
  cancel: () => void;
}

export interface GrantInput {
  subject: PermissionSubject;
  profile: PermissionProfile;
  /** Narrow the grant to a single requirement kind; omit to cover all kinds. */
  requirementKind?: PermissionRequirementKind;
  /** Narrow the grant to a scope (path glob, host, ...); omit for any scope. */
  scope?: string;
}

export interface ApprovalDecision {
  /** True when the approval was resolved and the step may proceed. */
  resolved: boolean;
  request: ApprovalRequest;
}

function grantRowToGrant(row: GrantRow): PermissionGrant {
  return {
    id: row.id,
    subject: { type: row.subject_type, id: row.subject_id },
    profile: row.profile,
    ...(row.requirement_kind !== null
      ? { requirementKind: row.requirement_kind }
      : {}),
    ...(row.scope !== null ? { scope: row.scope } : {}),
    grantedAt: row.granted_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

function approvalRowToRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.step_id !== null ? { stepId: row.step_id } : {}),
    summary: row.summary,
    requirements: JSON.parse(row.requirements) as PermissionRequirement[],
    status: row.status,
    createdAt: row.created_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  };
}

/** True when a scope grant covers a requested scope. A grant with no scope
 * covers any scope; otherwise scopes must match exactly. */
function scopeCovers(grantScope: string | null, requested?: string): boolean {
  if (grantScope === null) {
    return true;
  }
  return grantScope === requested;
}

export class PermissionService {
  private readonly inFlight = new Set<InFlightAction>();

  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
    /** Clock seam so tests can control timeout evaluation. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---- Profiles / grants ----

  /**
   * Grant a permission profile to an agent or workflow, optionally scoped to a
   * requirement kind and/or scope string. Returns the persisted grant and
   * appends an Audit_Event.
   */
  grant(input: GrantInput): PermissionGrant {
    const grant: PermissionGrant = {
      id: randomUUID(),
      subject: input.subject,
      profile: input.profile,
      ...(input.requirementKind !== undefined
        ? { requirementKind: input.requirementKind }
        : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      grantedAt: new Date(this.now()).toISOString(),
    };

    this.store.db
      .prepare(
        `INSERT INTO permission_grants
           (id, subject_type, subject_id, profile, requirement_kind, scope, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        grant.id,
        grant.subject.type,
        grant.subject.id,
        grant.profile,
        grant.requirementKind ?? null,
        grant.scope ?? null,
        grant.grantedAt,
      );

    this.audit.append({
      actor: 'user',
      action: 'permission_granted',
      target: `${grant.subject.type}:${grant.subject.id}`,
      redactedPayload: {
        profile: grant.profile,
        requirementKind: grant.requirementKind,
        scope: grant.scope,
      },
    });

    return grant;
  }

  /** Active (non-revoked) grants for a subject, newest first. */
  grantsFor(subject: PermissionSubject): PermissionGrant[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM permission_grants
         WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL
         ORDER BY granted_at DESC, rowid DESC`,
      )
      .all(subject.type, subject.id) as GrantRow[];
    return rows.map(grantRowToGrant);
  }

  /**
   * Whether the subject currently holds a grant permitting `requirement`
   * without a separate approval. A matching grant must cover the requirement
   * kind and scope, and its profile policy must both permit the kind and not
   * require an approval for it.
   */
  allows(subject: PermissionSubject, requirement: PermissionRequirement): boolean {
    return this.grantsFor(subject).some((grant) => {
      if (
        grant.requirementKind !== undefined &&
        grant.requirementKind !== requirement.kind
      ) {
        return false;
      }
      if (!scopeCovers(grant.scope ?? null, requirement.scope)) {
        return false;
      }
      const policy = policyFor(grant.profile, requirement.kind);
      return policy.permitted && !policy.requiresApproval;
    });
  }

  /**
   * Whether exercising `requirement` for `subject` requires an explicit
   * approval under the subject's current grants. True when the subject is
   * permitted the kind only through a profile that gates it behind approval
   * (assisted_execution for consequential kinds). When no grant permits the
   * kind at all, this returns false — `allows` is false and the caller must
   * treat it as denied rather than approvable.
   */
  requiresApproval(
    subject: PermissionSubject,
    requirement: PermissionRequirement,
  ): boolean {
    let permittedWithApproval = false;
    for (const grant of this.grantsFor(subject)) {
      if (
        grant.requirementKind !== undefined &&
        grant.requirementKind !== requirement.kind
      ) {
        continue;
      }
      if (!scopeCovers(grant.scope ?? null, requirement.scope)) {
        continue;
      }
      const policy = policyFor(grant.profile, requirement.kind);
      if (policy.permitted && !policy.requiresApproval) {
        return false; // already allowed outright; no approval needed
      }
      if (policy.permitted && policy.requiresApproval) {
        permittedWithApproval = true;
      }
    }
    return permittedWithApproval;
  }

  // ---- In-flight action registration ----

  /**
   * Register an in-flight action depending on a permission. Returns a disposer
   * the caller invokes when the action finishes so a later revocation does not
   * try to cancel completed work.
   */
  registerInFlight(action: InFlightAction): () => void {
    this.inFlight.add(action);
    return () => {
      this.inFlight.delete(action);
    };
  }

  // ---- Revocation ----

  /**
   * Revoke matching grants from a subject. Cancels in-flight actions that
   * depend on the revoked permission and blocks subsequent dependent actions
   * (future `allows`/`requiresApproval` return false), and expires any pending
   * approval requests for the affected requirement. Appends Audit_Events.
   *
   * When `requirementKind` is omitted, every active grant for the subject is
   * revoked; when provided, only grants covering that kind are revoked.
   */
  revoke(input: {
    subject: PermissionSubject;
    requirementKind?: PermissionRequirementKind;
    scope?: string;
  }): void {
    const revokedAt = new Date(this.now()).toISOString();
    const { subject } = input;

    const active = this.store.db
      .prepare(
        `SELECT * FROM permission_grants
         WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL`,
      )
      .all(subject.type, subject.id) as GrantRow[];

    const toRevoke = active.filter((row) => {
      if (
        input.requirementKind !== undefined &&
        row.requirement_kind !== null &&
        row.requirement_kind !== input.requirementKind
      ) {
        return false;
      }
      if (
        input.scope !== undefined &&
        row.scope !== null &&
        row.scope !== input.scope
      ) {
        return false;
      }
      return true;
    });

    if (toRevoke.length === 0) {
      return;
    }

    const revokeStmt = this.store.db.prepare(
      'UPDATE permission_grants SET revoked_at = ? WHERE id = ?',
    );
    this.store.transaction(() => {
      for (const row of toRevoke) {
        revokeStmt.run(revokedAt, row.id);
      }
    });

    this.audit.append({
      actor: 'user',
      action: 'permission_revoked',
      target: `${subject.type}:${subject.id}`,
      redactedPayload: {
        requirementKind: input.requirementKind,
        scope: input.scope,
        revokedGrantIds: toRevoke.map((r) => r.id),
      },
    });

    // Cancel dependent in-flight actions. An action is dependent when it shares
    // the subject and its requirement is no longer allowed after revocation.
    for (const action of [...this.inFlight]) {
      if (
        action.subject.type !== subject.type ||
        action.subject.id !== subject.id
      ) {
        continue;
      }
      if (this.allows(action.subject, action.requirement)) {
        continue; // another grant still covers it
      }
      this.inFlight.delete(action);
      this.audit.append({
        actor: 'orchestrator',
        action: 'action_cancelled_on_revocation',
        target: `${subject.type}:${subject.id}`,
        redactedPayload: { requirement: action.requirement },
      });
      action.cancel();
    }

    // Expire pending approvals that depend on the revoked permission.
    const pending = this.store.db
      .prepare(
        `SELECT * FROM approval_requests
         WHERE subject_type = ? AND subject_id = ? AND status IN ('pending', 'approved')`,
      )
      .all(subject.type, subject.id) as ApprovalRow[];
    for (const row of pending) {
      const requirements = JSON.parse(
        row.requirements,
      ) as PermissionRequirement[];
      const dependsOnRevoked = requirements.some((req) =>
        toRevoke.some(
          (g) =>
            (g.requirement_kind === null || g.requirement_kind === req.kind) &&
            scopeCovers(g.scope, req.scope),
        ),
      );
      if (dependsOnRevoked) {
        this.setApprovalStatus(row.id, 'expired', revokedAt);
        this.audit.append({
          actor: 'orchestrator',
          action: 'approval_expired_on_revocation',
          target: row.task_id,
          redactedPayload: { approvalId: row.id },
        });
      }
    }
  }

  // ---- Approval lifecycle ----

  /**
   * Create a pending Approval_Request for a consequential step. The task is
   * expected to be in WAITING_FOR_APPROVAL by the orchestrator before this is
   * called; the request carries a 24-hour expiry.
   */
  requestApproval(input: {
    taskId: string;
    stepId?: string;
    subject: PermissionSubject;
    summary: string;
    requirements: PermissionRequirement[];
  }): ApprovalRequest {
    const createdMs = this.now();
    const request: ApprovalRequest = {
      id: randomUUID(),
      taskId: input.taskId,
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      summary: input.summary,
      requirements: input.requirements,
      status: 'pending',
      createdAt: new Date(createdMs).toISOString(),
    };
    const expiresAt = new Date(createdMs + APPROVAL_TIMEOUT_MS).toISOString();

    this.store.db
      .prepare(
        `INSERT INTO approval_requests
           (id, task_id, step_id, subject_type, subject_id, summary, requirements, status, created_at, expires_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      )
      .run(
        request.id,
        request.taskId,
        request.stepId ?? null,
        input.subject.type,
        input.subject.id,
        request.summary,
        JSON.stringify(request.requirements),
        request.createdAt,
        expiresAt,
      );

    this.audit.append({
      actor: 'orchestrator',
      action: 'approval_requested',
      target: request.taskId,
      redactedPayload: {
        approvalId: request.id,
        subject: input.subject,
        requirements: request.requirements,
      },
    });

    return request;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM approval_requests WHERE id = ?')
      .get(id) as ApprovalRow | undefined;
    return row === undefined ? undefined : approvalRowToRequest(row);
  }

  /** Pending approvals for a task that have not yet expired by wall clock. */
  pendingApprovals(taskId: string): ApprovalRequest[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM approval_requests
         WHERE task_id = ? AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId) as ApprovalRow[];
    return rows.map(approvalRowToRequest);
  }

  /**
   * Approve a pending request. Re-checks that the subject still holds a grant
   * that permits the requested requirements (Requirement 9.3). If the
   * permission was revoked in the interim, the request is NOT approved — it is
   * expired instead — and `resolved` is false so the caller does not proceed.
   */
  approve(id: string): ApprovalDecision {
    const row = this.loadPendingOrExpire(id);
    if (row === undefined) {
      const current = this.getApproval(id);
      if (current === undefined) {
        throw new PermissionError(`Approval request ${id} not found`);
      }
      return { resolved: false, request: current };
    }

    const subject: PermissionSubject = {
      type: row.subject_type,
      id: row.subject_id,
    };
    const requirements = JSON.parse(
      row.requirements,
    ) as PermissionRequirement[];

    // Re-check permission still granted. allows() OR requiresApproval() means
    // the subject still holds a profile permitting the kind; a fully revoked
    // permission yields neither.
    const stillPermitted = requirements.every(
      (req) =>
        this.allows(subject, req) || this.requiresApproval(subject, req),
    );
    if (!stillPermitted) {
      const resolvedAt = new Date(this.now()).toISOString();
      this.setApprovalStatus(id, 'expired', resolvedAt);
      this.audit.append({
        actor: 'orchestrator',
        action: 'approval_rechecked_revoked',
        target: row.task_id,
        redactedPayload: { approvalId: id },
      });
      return { resolved: false, request: this.getApproval(id)! };
    }

    const resolvedAt = new Date(this.now()).toISOString();
    this.setApprovalStatus(id, 'approved', resolvedAt);
    this.audit.append({
      actor: 'user',
      action: 'approval_approved',
      target: row.task_id,
      redactedPayload: { approvalId: id },
    });
    return { resolved: true, request: this.getApproval(id)! };
  }

  /** Deny a pending request. The caller decides BLOCKED vs CANCELLED. */
  deny(id: string): ApprovalDecision {
    const row = this.loadPendingOrExpire(id);
    if (row === undefined) {
      const current = this.getApproval(id);
      if (current === undefined) {
        throw new PermissionError(`Approval request ${id} not found`);
      }
      return { resolved: false, request: current };
    }
    const resolvedAt = new Date(this.now()).toISOString();
    this.setApprovalStatus(id, 'denied', resolvedAt);
    this.audit.append({
      actor: 'user',
      action: 'approval_denied',
      target: row.task_id,
      redactedPayload: { approvalId: id },
    });
    return { resolved: true, request: this.getApproval(id)! };
  }

  /**
   * Sweep pending approvals whose 24-hour window has elapsed and mark them
   * expired. Returns the ids expired. Per Requirement 9.5 the orchestrator
   * leaves the task in WAITING_FOR_APPROVAL and does not proceed — expiring the
   * request here never advances the task.
   */
  expireTimedOut(): string[] {
    const nowMs = this.now();
    const rows = this.store.db
      .prepare(`SELECT * FROM approval_requests WHERE status = 'pending'`)
      .all() as ApprovalRow[];
    const expired: string[] = [];
    for (const row of rows) {
      if (Date.parse(row.expires_at) <= nowMs) {
        const resolvedAt = new Date(nowMs).toISOString();
        this.setApprovalStatus(row.id, 'expired', resolvedAt);
        this.audit.append({
          actor: 'orchestrator',
          action: 'approval_expired_timeout',
          target: row.task_id,
          redactedPayload: { approvalId: row.id },
        });
        expired.push(row.id);
      }
    }
    return expired;
  }

  /**
   * Load a request if it is still pending and within its window; if its window
   * has elapsed, mark it expired and return undefined so approve/deny become
   * no-ops on a timed-out request.
   */
  private loadPendingOrExpire(id: string): ApprovalRow | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM approval_requests WHERE id = ?')
      .get(id) as ApprovalRow | undefined;
    if (row === undefined || row.status !== 'pending') {
      return undefined;
    }
    if (Date.parse(row.expires_at) <= this.now()) {
      const resolvedAt = new Date(this.now()).toISOString();
      this.setApprovalStatus(id, 'expired', resolvedAt);
      this.audit.append({
        actor: 'orchestrator',
        action: 'approval_expired_timeout',
        target: row.task_id,
        redactedPayload: { approvalId: id },
      });
      return undefined;
    }
    return row;
  }

  private setApprovalStatus(
    id: string,
    status: ApprovalStatus,
    resolvedAt: string,
  ): void {
    this.store.db
      .prepare(
        'UPDATE approval_requests SET status = ?, resolved_at = ? WHERE id = ?',
      )
      .run(status, resolvedAt, id);
  }
}
