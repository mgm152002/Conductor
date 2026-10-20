import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import {
  APPROVAL_TIMEOUT_MS,
  PermissionError,
  PermissionService,
  type PermissionSubject,
} from '@main/domain/permission-service';
import type { PermissionRequirement } from '@shared/domain';

// Unit tests for Requirement 9 permission gating + audit redaction:
//   9.4 — deny transitions resolve the request and append an Audit_Event
//   9.5 — a 24-hour approval timeout leaves the request un-resolved
//   9.6 — every privileged operation appends an immutable, redacted Audit_Event
//   9.7 — revocation cancels dependent in-flight actions and blocks subsequent ones
//   Property 7 — a consequential action only proceeds via an approved request
//                consistent with the active permission profile

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;

// Controllable clock seam so the 24-hour timeout is testable deterministically.
let clockMs: number;
const now = () => clockMs;

const AGENT: PermissionSubject = { type: 'agent', id: 'cli-adapter' };

const WRITE: PermissionRequirement = {
  kind: 'filesystem_write',
  scope: '/repo/src',
};
const READ: PermissionRequirement = { kind: 'filesystem_read' };

function newService(): PermissionService {
  return new PermissionService(store, audit, now);
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-perm-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  clockMs = Date.parse('2025-01-01T00:00:00.000Z');
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('PermissionService grants and gating (Property 7)', () => {
  it('read_only permits non-consequential reads but never writes', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'read_only' });

    expect(svc.allows(AGENT, READ)).toBe(true);
    expect(svc.allows(AGENT, WRITE)).toBe(false);
    // A write is not even approvable under read_only.
    expect(svc.requiresApproval(AGENT, WRITE)).toBe(false);
  });

  it('assisted_execution gates consequential actions behind approval', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });

    // Reads flow through without approval; writes require one.
    expect(svc.allows(AGENT, READ)).toBe(true);
    expect(svc.allows(AGENT, WRITE)).toBe(false);
    expect(svc.requiresApproval(AGENT, WRITE)).toBe(true);
  });

  it('trusted_automation allows consequential actions outright', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'trusted_automation' });

    expect(svc.allows(AGENT, WRITE)).toBe(true);
    expect(svc.requiresApproval(AGENT, WRITE)).toBe(false);
  });

  it('honors requirement-kind and scope narrowing on a grant', () => {
    const svc = newService();
    svc.grant({
      subject: AGENT,
      profile: 'trusted_automation',
      requirementKind: 'filesystem_write',
      scope: '/repo/src',
    });

    expect(svc.allows(AGENT, WRITE)).toBe(true);
    // Different scope → not covered.
    expect(
      svc.allows(AGENT, { kind: 'filesystem_write', scope: '/etc' }),
    ).toBe(false);
    // Different kind → not covered.
    expect(svc.allows(AGENT, { kind: 'command_exec' })).toBe(false);
  });

  it('denies a subject with no grant at all', () => {
    const svc = newService();
    expect(svc.allows(AGENT, READ)).toBe(false);
    expect(svc.requiresApproval(AGENT, WRITE)).toBe(false);
  });
});

describe('Approval approve transition (9.3 re-check, Property 7)', () => {
  it('approves a pending request while the permission still holds', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const req = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'write file',
      requirements: [WRITE],
    });
    expect(req.status).toBe('pending');

    const decision = svc.approve(req.id);
    expect(decision.resolved).toBe(true);
    expect(decision.request.status).toBe('approved');
    expect(svc.getApproval(req.id)?.status).toBe('approved');
  });

  it('does not approve when the permission was revoked in the interim', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const req = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'write file',
      requirements: [WRITE],
    });

    // Permission pulled before the user acts on the approval.
    svc.revoke({ subject: AGENT });

    const decision = svc.approve(req.id);
    expect(decision.resolved).toBe(false);
    expect(decision.request.status).toBe('expired');
  });

  it('throws when approving an unknown request id', () => {
    const svc = newService();
    expect(() => svc.approve('does-not-exist')).toThrow(PermissionError);
  });
});

describe('Approval deny transition (9.4)', () => {
  it('denies a pending request and appends an Audit_Event', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const req = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'write file',
      requirements: [WRITE],
    });

    const decision = svc.deny(req.id);
    expect(decision.resolved).toBe(true);
    expect(decision.request.status).toBe('denied');
    expect(svc.getApproval(req.id)?.status).toBe('denied');

    const denials = audit
      .list()
      .filter((e) => e.action === 'approval_denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]?.target).toBe('task-1');
  });

  it('throws when denying an unknown request id', () => {
    const svc = newService();
    expect(() => svc.deny('does-not-exist')).toThrow(PermissionError);
  });

  it('is a no-op on an already-resolved request', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const req = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'write file',
      requirements: [WRITE],
    });
    svc.deny(req.id);

    const second = svc.deny(req.id);
    expect(second.resolved).toBe(false);
    expect(second.request.status).toBe('denied'); // unchanged
  });
});

describe('Approval 24-hour timeout (9.5)', () => {
  it('leaves the request un-resolved and does not approve after timeout', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const req = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'write file',
      requirements: [WRITE],
    });

    // Advance just past the 24-hour window.
    clockMs += APPROVAL_TIMEOUT_MS + 1;

    // Acting on a timed-out request must not let it proceed.
    const approve = svc.approve(req.id);
    expect(approve.resolved).toBe(false);
    expect(approve.request.status).toBe('expired');
  });

  it('does not expire a request one millisecond before the window elapses', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const req = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'write file',
      requirements: [WRITE],
    });

    clockMs += APPROVAL_TIMEOUT_MS - 1;
    const decision = svc.approve(req.id);
    expect(decision.resolved).toBe(true);
    expect(decision.request.status).toBe('approved');
  });

  it('expireTimedOut sweeps elapsed pending requests only', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const stale = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'stale',
      requirements: [WRITE],
    });

    // Second request created 12 hours later, so it is still within its window
    // when we sweep at the 24h+ mark of the first one.
    clockMs += 12 * 60 * 60 * 1000;
    const fresh = svc.requestApproval({
      taskId: 'task-2',
      subject: AGENT,
      summary: 'fresh',
      requirements: [WRITE],
    });

    // Now at 24h + 1ms relative to the first request.
    clockMs = Date.parse('2025-01-01T00:00:00.000Z') + APPROVAL_TIMEOUT_MS + 1;
    const expired = svc.expireTimedOut();

    expect(expired).toEqual([stale.id]);
    expect(svc.getApproval(stale.id)?.status).toBe('expired');
    expect(svc.getApproval(fresh.id)?.status).toBe('pending');
  });
});

describe('Revocation cancels dependent actions (9.7)', () => {
  it('cancels an in-flight action that depends on the revoked grant', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'trusted_automation' });

    const cancel = vi.fn();
    const dispose = svc.registerInFlight({
      subject: AGENT,
      requirement: WRITE,
      cancel,
    });

    svc.revoke({ subject: AGENT });

    expect(cancel).toHaveBeenCalledTimes(1);
    // The grant is gone, so subsequent dependent actions are blocked.
    expect(svc.allows(AGENT, WRITE)).toBe(false);

    dispose(); // disposer stays safe to call after cancellation
  });

  it('leaves an action covered by a differently-scoped grant alone when revoking another kind', () => {
    const svc = newService();
    // Two narrow grants on distinct kinds. A write action depends only on the
    // write grant; revoking the command_exec grant must not touch it.
    svc.grant({
      subject: AGENT,
      profile: 'trusted_automation',
      requirementKind: 'filesystem_write',
    });
    svc.grant({
      subject: AGENT,
      profile: 'trusted_automation',
      requirementKind: 'command_exec',
    });

    const cancel = vi.fn();
    svc.registerInFlight({ subject: AGENT, requirement: WRITE, cancel });

    // Revoke only command_exec; the write grant still covers the in-flight write.
    svc.revoke({ subject: AGENT, requirementKind: 'command_exec' });

    expect(cancel).not.toHaveBeenCalled();
    expect(svc.allows(AGENT, WRITE)).toBe(true);
  });

  it('revoking by kind also strips a broad all-kinds grant covering that kind', () => {
    const svc = newService();
    // A broad (all-kinds) grant covers filesystem_write, so a revoke scoped to
    // filesystem_write must remove it and cancel the dependent action.
    svc.grant({ subject: AGENT, profile: 'trusted_automation' });

    const cancel = vi.fn();
    svc.registerInFlight({ subject: AGENT, requirement: WRITE, cancel });

    svc.revoke({ subject: AGENT, requirementKind: 'filesystem_write' });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(svc.allows(AGENT, WRITE)).toBe(false);
  });

  it('leaves actions for other subjects untouched', () => {
    const svc = newService();
    const other: PermissionSubject = { type: 'agent', id: 'other' };
    svc.grant({ subject: AGENT, profile: 'trusted_automation' });
    svc.grant({ subject: other, profile: 'trusted_automation' });

    const cancelOther = vi.fn();
    svc.registerInFlight({
      subject: other,
      requirement: WRITE,
      cancel: cancelOther,
    });

    svc.revoke({ subject: AGENT });
    expect(cancelOther).not.toHaveBeenCalled();
  });

  it('expires pending approvals that depend on the revoked permission', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const req = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'write file',
      requirements: [WRITE],
    });

    svc.revoke({ subject: AGENT });

    expect(svc.getApproval(req.id)?.status).toBe('expired');
  });

  it('is a no-op when no matching grant exists', () => {
    const svc = newService();
    const before = audit.list().length;
    svc.revoke({ subject: AGENT });
    // No grant to revoke → no audit event appended.
    expect(audit.list().length).toBe(before);
  });
});

describe('Audit log immutability and redaction (9.6, Property 6)', () => {
  it('appends an Audit_Event for every privileged operation', () => {
    const svc = newService();
    svc.grant({ subject: AGENT, profile: 'assisted_execution' });
    const req = svc.requestApproval({
      taskId: 'task-1',
      subject: AGENT,
      summary: 'write file',
      requirements: [WRITE],
    });
    svc.approve(req.id);
    svc.revoke({ subject: AGENT });

    const actions = audit.list().map((e) => e.action);
    expect(actions).toContain('permission_granted');
    expect(actions).toContain('approval_requested');
    expect(actions).toContain('approval_approved');
    expect(actions).toContain('permission_revoked');
  });

  it('redacts secret-bearing fields from audit payloads', () => {
    // A caller hands the service a payload laced with a secret under the
    // summary/requirements it persists. We simulate the general case by
    // appending through the same AuditLog with sensitive keys present.
    audit.append({
      actor: 'cli-adapter',
      action: 'command_exec',
      target: 'task-1',
      redactedPayload: {
        command: 'deploy',
        apiKey: 'sk-live-super-secret',
        nested: { password: 'hunter2', note: 'keep' },
      },
    });

    const event = audit
      .list()
      .find((e) => e.action === 'command_exec');
    const payload = event?.redactedPayload as Record<string, unknown>;
    expect(payload['apiKey']).toBe('[REDACTED]');
    const nested = payload['nested'] as Record<string, unknown>;
    expect(nested['password']).toBe('[REDACTED]');
    expect(nested['note']).toBe('keep');
    // Non-sensitive data is preserved.
    expect(payload['command']).toBe('deploy');
  });

  it('never persists a raw secret value anywhere in the serialized log', () => {
    const secretValue = 'sk-live-super-secret-value';
    audit.append({
      actor: 'cli-adapter',
      action: 'secret_used',
      target: 'task-1',
      redactedPayload: {
        token: secretValue,
        credentials: { accessKey: secretValue },
      },
    });

    // Serialize the entire persisted log and assert the secret never appears.
    const serialized = JSON.stringify(audit.list());
    expect(serialized).not.toContain(secretValue);
  });

  it('preserves placeholder secret tokens (they carry no value)', () => {
    audit.append({
      actor: 'cli-adapter',
      action: 'secret_referenced',
      target: 'task-1',
      redactedPayload: { token: '{{SECRET:stripe_key}}' },
    });

    const event = audit.list().find((e) => e.action === 'secret_referenced');
    const payload = event?.redactedPayload as Record<string, unknown>;
    expect(payload['token']).toBe('{{SECRET:stripe_key}}');
  });
});
