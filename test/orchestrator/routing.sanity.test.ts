// Basic sanity checks for deterministic capability-based routing. The dedicated
// unit test lives in task 10.2; this file only guards the core invariants:
// identical inputs yield the identical single selection, and a step with no
// eligible adapter is flagged for fallback or blocked.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import {
  PermissionService,
  type PermissionSubject,
} from '@main/domain/permission-service';
import { Registry } from '@main/registry/registry';
import {
  selectAdapters,
  type RoutableStep,
} from '@main/orchestrator/routing';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import type { AdapterRecord, CapabilityDescriptor } from '@shared/adapter';

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;
let permissions: PermissionService;
let registry: Registry;

const subject: PermissionSubject = { type: 'agent', id: 'router-tests' };

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-routing-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  permissions = new PermissionService(store, audit);
  registry = new Registry();
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function cap(
  id: string,
  overrides: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  return {
    id,
    title: id,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    streaming: false,
    cancellable: true,
    resumable: false,
    requiredPermissions: [],
    ...overrides,
  };
}

function registerAdapter(
  id: string,
  capability: CapabilityDescriptor,
  record: Partial<AdapterRecord> = {},
): void {
  registry.register(
    makeFakeAdapter({
      record: { id, name: id, capabilities: [capability], ...record },
    }),
  );
}

describe('selectAdapters', () => {
  it('selects exactly one adapter deterministically for the same inputs', () => {
    // Three equally-eligible candidates; the id tiebreaker must pick the same
    // one every time regardless of registration order.
    registerAdapter('zeta', cap('code.edit'));
    registerAdapter('alpha', cap('code.edit'));
    registerAdapter('mu', cap('code.edit'));

    const steps: RoutableStep[] = [
      { id: 's1', requiredCapability: 'code.edit' },
    ];

    const first = selectAdapters({ steps, registry, permissions, subject });
    const second = selectAdapters({ steps, registry, permissions, subject });

    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe('assigned');
    expect(first[0]?.assignedAdapterId).toBe('alpha'); // lexicographically first
    expect(second).toEqual(first);
  });

  it('prefers lower cost/latency over the id tiebreaker', () => {
    registerAdapter('zeta', cap('text.summarize', { costHint: 'low' }));
    registerAdapter('alpha', cap('text.summarize', { costHint: 'high' }));

    const [decision] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'text.summarize' }],
      registry,
      permissions,
      subject,
    });

    expect(decision?.assignedAdapterId).toBe('zeta'); // cheaper wins despite id
  });

  it('skips unavailable adapters and blocks when none are available', () => {
    registerAdapter('off', cap('build.run'), { available: false });

    const [decision] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'build.run' }],
      registry,
      permissions,
      subject,
    });

    expect(decision?.kind).toBe('blocked');
    expect(decision?.reason).toBe('none_available');
    expect(decision?.assignedAdapterId).toBeUndefined();
  });

  it('blocks a step whose permissions are unsatisfiable under the active profile', () => {
    // read_only subject cannot perform a filesystem write, and holds no grant
    // that would permit it even behind approval.
    permissions.grant({ subject, profile: 'read_only' });
    registerAdapter(
      'writer',
      cap('file.write', {
        requiredPermissions: [{ kind: 'filesystem_write' }],
      }),
    );

    const [decision] = selectAdapters({
      steps: [
        {
          id: 's1',
          requiredCapability: 'file.write',
          requiredPermissions: [{ kind: 'filesystem_write' }],
        },
      ],
      registry,
      permissions,
      subject,
    });

    expect(decision?.kind).toBe('blocked');
    expect(decision?.reason).toBe('permissions_unsatisfiable');
  });

  it('flags a deterministic fallback when one is registered for the capability', () => {
    const [decision] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'image.resize' }],
      registry,
      permissions,
      subject,
      fallbackAutomations: new Map([['image.resize', 'builtin-image-resize']]),
    });

    expect(decision?.kind).toBe('fallback');
    expect(decision?.reason).toBe('no_candidates');
    expect(decision?.fallbackAutomationId).toBe('builtin-image-resize');
  });

  it('routes an approval-gated permission as eligible', () => {
    // assisted_execution permits consequential kinds behind approval, so the
    // step is routable (not blocked).
    permissions.grant({ subject, profile: 'assisted_execution' });
    registerAdapter(
      'writer',
      cap('file.write', {
        requiredPermissions: [{ kind: 'filesystem_write' }],
      }),
    );

    const [decision] = selectAdapters({
      steps: [
        {
          id: 's1',
          requiredCapability: 'file.write',
          requiredPermissions: [{ kind: 'filesystem_write' }],
        },
      ],
      registry,
      permissions,
      subject,
    });

    expect(decision?.kind).toBe('assigned');
    expect(decision?.assignedAdapterId).toBe('writer');
  });

  it('uses historical performance as a late tiebreaker', () => {
    registerAdapter('alpha', cap('code.review'));
    registerAdapter('beta', cap('code.review'));

    const [decision] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'code.review' }],
      registry,
      permissions,
      subject,
      // beta has a better track record; all earlier stages tie, so beta wins
      // despite alpha sorting first by id.
      historicalPerformance: (adapterId) => (adapterId === 'beta' ? 0.9 : 0.1),
    });

    expect(decision?.assignedAdapterId).toBe('beta');
  });
});
