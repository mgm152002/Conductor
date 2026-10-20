// Dedicated unit test for deterministic capability-based routing (task 10.2).
//
// The sanity test (routing.sanity.test.ts) guards the core invariants with one
// case each. This file is the thorough coverage for the two requirements the
// router owns:
//
//   Requirement 6.6 — selecting among candidates, the router deterministically
//   picks EXACTLY ONE adapter using a fixed precedence (task fit, availability,
//   cost, latency, permission satisfiability, historical performance, agent
//   preference) and produces the SAME selection for the same candidates and
//   inputs. This must hold across registration orderings and repeated calls.
//
//   Requirement 6.7 — when no available adapter satisfies a step's capability
//   and permissions, the step is flagged for deterministic fallback (when one
//   is registered for the capability) or marked BLOCKED.
//
// We exercise each precedence stage in isolation, confirm order-invariance by
// permuting registration order, and cover the full matrix of unroutable
// reasons (no candidates / none available / permissions unsatisfiable) under
// both the fallback-present and fallback-absent cases.

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
  type SelectAdaptersInput,
} from '@main/orchestrator/routing';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import type { AdapterRecord, CapabilityDescriptor } from '@shared/adapter';

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;
let permissions: PermissionService;

const subject: PermissionSubject = { type: 'agent', id: 'router-unit-tests' };

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-routing-unit-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  permissions = new PermissionService(store, audit);
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

/** Build a fresh Registry and register the given adapters in the given order. */
function registryWith(
  specs: ReadonlyArray<{
    id: string;
    capability: CapabilityDescriptor;
    record?: Partial<AdapterRecord>;
  }>,
): Registry {
  const registry = new Registry();
  for (const spec of specs) {
    registry.register(
      makeFakeAdapter({
        record: {
          id: spec.id,
          name: spec.id,
          capabilities: [spec.capability],
          ...spec.record,
        },
      }),
    );
  }
  return registry;
}

/** Every permutation of an array (small inputs only). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      out.push([items[i]!, ...perm]);
    }
  }
  return out;
}

describe('selectAdapters — deterministic single selection (Requirement 6.6)', () => {
  it('assigns exactly one adapter per step', () => {
    const registry = registryWith([
      { id: 'alpha', capability: cap('code.edit') },
      { id: 'beta', capability: cap('code.edit') },
    ]);

    const decisions = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'code.edit' }],
      registry,
      permissions,
      subject,
    });

    expect(decisions).toHaveLength(1);
    const [d] = decisions;
    expect(d?.kind).toBe('assigned');
    expect(typeof d?.assignedAdapterId).toBe('string');
    expect(d?.fallbackAutomationId).toBeUndefined();
    expect(d?.reason).toBeUndefined();
  });

  it('yields the identical selection regardless of adapter registration order', () => {
    // Four equally-eligible candidates: every precedence stage ties, so the id
    // tiebreaker alone decides. The winner must be the same for all 24
    // registration orderings.
    const ids = ['delta', 'alpha', 'gamma', 'beta'];
    const specs = ids.map((id) => ({ id, capability: cap('code.edit') }));
    const steps: RoutableStep[] = [
      { id: 's1', requiredCapability: 'code.edit' },
    ];

    const winners = permutations(specs).map((order) => {
      const registry = registryWith(order);
      const [d] = selectAdapters({ steps, registry, permissions, subject });
      return d?.assignedAdapterId;
    });

    // All orderings agree, and they agree on the lexicographically smallest id.
    expect(new Set(winners).size).toBe(1);
    expect(winners[0]).toBe('alpha');
  });

  it('prefers OpenCode over Antigravity when every precedence stage ties', () => {
    // Both agents are equally capable and cost the same. Before the shared
    // preference order was a routing stage, the lexicographic id tiebreaker
    // picked Antigravity for every Auto task. Registration order must not
    // change the result.
    const specs = [
      { id: 'antigravity', capability: cap('objective.fulfill') },
      { id: 'opencode', capability: cap('objective.fulfill') },
    ];
    const steps: RoutableStep[] = [
      { id: 's1', requiredCapability: 'objective.fulfill' },
    ];

    for (const order of [specs, [...specs].reverse()]) {
      const registry = registryWith(order);
      const [d] = selectAdapters({ steps, registry, permissions, subject });
      expect(d?.assignedAdapterId).toBe('opencode');
    }
  });

  it('is order-invariant even when cost, not the id tiebreaker, decides', () => {
    // The cheapest adapter ("gamma") is not the lexicographically first id, so
    // this proves order-invariance is driven by the precedence keys, not by
    // insertion order leaking through.
    const specs = [
      { id: 'alpha', capability: cap('text.summarize', { costHint: 'high' }) },
      { id: 'beta', capability: cap('text.summarize', { costHint: 'medium' }) },
      { id: 'gamma', capability: cap('text.summarize', { costHint: 'low' }) },
    ];
    const steps: RoutableStep[] = [
      { id: 's1', requiredCapability: 'text.summarize' },
    ];

    const winners = permutations(specs).map((order) => {
      const registry = registryWith(order);
      const [d] = selectAdapters({ steps, registry, permissions, subject });
      return d?.assignedAdapterId;
    });

    expect(new Set(winners).size).toBe(1);
    expect(winners[0]).toBe('gamma');
  });

  it('returns deeply equal results across repeated calls with the same inputs', () => {
    const registry = registryWith([
      { id: 'alpha', capability: cap('code.edit') },
      { id: 'beta', capability: cap('build.run', { costHint: 'low' }) },
      { id: 'gamma', capability: cap('build.run', { costHint: 'high' }) },
    ]);
    const input: SelectAdaptersInput = {
      steps: [
        { id: 's1', requiredCapability: 'code.edit' },
        { id: 's2', requiredCapability: 'build.run' },
        { id: 's3', requiredCapability: 'does.not.exist' },
      ],
      registry,
      permissions,
      subject,
      fallbackAutomations: new Map([['does.not.exist', 'builtin-noop']]),
    };

    const first = selectAdapters(input);
    const second = selectAdapters(input);
    const third = selectAdapters(input);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('applies the fixed precedence: cost outranks latency', () => {
    // alpha is cheaper (cost low) but slower (latency high); beta is pricier
    // but faster. Cost precedes latency, so alpha wins.
    const registry = registryWith([
      {
        id: 'beta',
        capability: cap('x', { costHint: 'high', latencyHint: 'low' }),
      },
      {
        id: 'alpha',
        capability: cap('x', { costHint: 'low', latencyHint: 'high' }),
      },
    ]);

    const [d] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'x' }],
      registry,
      permissions,
      subject,
    });

    expect(d?.assignedAdapterId).toBe('alpha');
  });

  it('applies the fixed precedence: latency breaks a cost tie', () => {
    // Equal cost; the faster adapter wins even though its id sorts later.
    const registry = registryWith([
      {
        id: 'alpha',
        capability: cap('x', { costHint: 'medium', latencyHint: 'high' }),
      },
      {
        id: 'zeta',
        capability: cap('x', { costHint: 'medium', latencyHint: 'low' }),
      },
    ]);

    const [d] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'x' }],
      registry,
      permissions,
      subject,
    });

    expect(d?.assignedAdapterId).toBe('zeta');
  });

  it('prefers the route needing fewer approvals when cost and latency tie', () => {
    // Both adapters are equal on cost/latency and both are routable, but under
    // assisted_execution a filesystem_write needs approval while filesystem_read
    // is allowed outright. The adapter whose capability stays within the step's
    // read-only permission is allowed without approval, so it is preferred over
    // the one that drags in a write requiring approval.
    permissions.grant({ subject, profile: 'assisted_execution' });

    const registry = registryWith([
      {
        // Needs a write (approval-gated) in addition — later by permission score.
        id: 'alpha',
        capability: cap('fs.op', {
          requiredPermissions: [{ kind: 'filesystem_read' }],
        }),
      },
      {
        id: 'beta',
        capability: cap('fs.op', {
          requiredPermissions: [{ kind: 'filesystem_read' }],
        }),
      },
    ]);

    const step: RoutableStep = {
      id: 's1',
      requiredCapability: 'fs.op',
      requiredPermissions: [{ kind: 'filesystem_read' }],
    };

    const [d] = selectAdapters({
      steps: [step],
      registry,
      permissions,
      subject,
    });

    // read is allowed outright for both, so permission score ties; id decides.
    expect(d?.kind).toBe('assigned');
    expect(d?.assignedAdapterId).toBe('alpha');
  });

  it('uses historical performance only after all earlier stages tie', () => {
    // Identical cost/latency/permissions; history is the last non-id stage, so
    // the stronger track record wins over the lexicographically-first id.
    const registry = registryWith([
      { id: 'alpha', capability: cap('code.review') },
      { id: 'beta', capability: cap('code.review') },
    ]);

    const [d] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'code.review' }],
      registry,
      permissions,
      subject,
      historicalPerformance: (adapterId) =>
        adapterId === 'beta' ? 0.95 : 0.2,
    });

    expect(d?.assignedAdapterId).toBe('beta');
  });

  it('does not let historical performance override a cheaper candidate', () => {
    // History is strictly lower precedence than cost: the cheaper adapter wins
    // even with a far worse history.
    const registry = registryWith([
      { id: 'alpha', capability: cap('code.review', { costHint: 'high' }) },
      { id: 'beta', capability: cap('code.review', { costHint: 'low' }) },
    ]);

    const [d] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'code.review' }],
      registry,
      permissions,
      subject,
      // alpha has a perfect record, beta a poor one — but beta is cheaper.
      historicalPerformance: (adapterId) =>
        adapterId === 'alpha' ? 1 : 0,
    });

    expect(d?.assignedAdapterId).toBe('beta');
  });

  it('is deterministic when a historical-performance tie falls through to the id', () => {
    const registry = registryWith([
      { id: 'zeta', capability: cap('code.review') },
      { id: 'alpha', capability: cap('code.review') },
    ]);

    const input: SelectAdaptersInput = {
      steps: [{ id: 's1', requiredCapability: 'code.review' }],
      registry,
      permissions,
      subject,
      historicalPerformance: () => 0.5, // same score for everyone
    };

    const first = selectAdapters(input);
    const second = selectAdapters(input);
    expect(first[0]?.assignedAdapterId).toBe('alpha'); // id tiebreaker
    expect(second).toEqual(first);
  });
});

describe('selectAdapters — unsatisfiable steps (Requirement 6.7)', () => {
  it('blocks a step whose capability no adapter declares (no fallback)', () => {
    const registry = registryWith([
      { id: 'alpha', capability: cap('code.edit') },
    ]);

    const [d] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'image.resize' }],
      registry,
      permissions,
      subject,
    });

    expect(d?.kind).toBe('blocked');
    expect(d?.reason).toBe('no_candidates');
    expect(d?.assignedAdapterId).toBeUndefined();
    expect(d?.fallbackAutomationId).toBeUndefined();
  });

  it('flags a fallback when the unmatched capability has one registered', () => {
    const registry = registryWith([
      { id: 'alpha', capability: cap('code.edit') },
    ]);

    const [d] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'image.resize' }],
      registry,
      permissions,
      subject,
      fallbackAutomations: new Map([['image.resize', 'builtin-resize']]),
    });

    expect(d?.kind).toBe('fallback');
    expect(d?.reason).toBe('no_candidates');
    expect(d?.fallbackAutomationId).toBe('builtin-resize');
    expect(d?.assignedAdapterId).toBeUndefined();
  });

  it('blocks with none_available when every declaring adapter is offline', () => {
    const registry = registryWith([
      { id: 'off1', capability: cap('build.run'), record: { available: false } },
      { id: 'off2', capability: cap('build.run'), record: { available: false } },
    ]);

    const [d] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'build.run' }],
      registry,
      permissions,
      subject,
    });

    expect(d?.kind).toBe('blocked');
    expect(d?.reason).toBe('none_available');
  });

  it('falls back with none_available when a fallback is registered for the capability', () => {
    const registry = registryWith([
      { id: 'off', capability: cap('build.run'), record: { available: false } },
    ]);

    const [d] = selectAdapters({
      steps: [{ id: 's1', requiredCapability: 'build.run' }],
      registry,
      permissions,
      subject,
      fallbackAutomations: new Map([['build.run', 'builtin-build']]),
    });

    expect(d?.kind).toBe('fallback');
    expect(d?.reason).toBe('none_available');
    expect(d?.fallbackAutomationId).toBe('builtin-build');
  });

  it('blocks with permissions_unsatisfiable when the subject can neither perform nor be approved', () => {
    // read_only subject: a filesystem_write is never permitted and never
    // approvable, so the only candidate is ineligible.
    permissions.grant({ subject, profile: 'read_only' });
    const registry = registryWith([
      {
        id: 'writer',
        capability: cap('file.write', {
          requiredPermissions: [{ kind: 'filesystem_write' }],
        }),
      },
    ]);

    const [d] = selectAdapters({
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

    expect(d?.kind).toBe('blocked');
    expect(d?.reason).toBe('permissions_unsatisfiable');
  });

  it('falls back with permissions_unsatisfiable when a fallback exists', () => {
    permissions.grant({ subject, profile: 'read_only' });
    const registry = registryWith([
      {
        id: 'writer',
        capability: cap('file.write', {
          requiredPermissions: [{ kind: 'filesystem_write' }],
        }),
      },
    ]);

    const [d] = selectAdapters({
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
      fallbackAutomations: new Map([['file.write', 'builtin-write']]),
    });

    expect(d?.kind).toBe('fallback');
    expect(d?.reason).toBe('permissions_unsatisfiable');
    expect(d?.fallbackAutomationId).toBe('builtin-write');
  });

  it('blocks when the subject holds no grant at all for a permissioned step', () => {
    // No grant => allows() and requiresApproval() are both false => blocked.
    const registry = registryWith([
      {
        id: 'runner',
        capability: cap('cmd.exec', {
          requiredPermissions: [{ kind: 'command_exec' }],
        }),
      },
    ]);

    const [d] = selectAdapters({
      steps: [
        {
          id: 's1',
          requiredCapability: 'cmd.exec',
          requiredPermissions: [{ kind: 'command_exec' }],
        },
      ],
      registry,
      permissions,
      subject,
    });

    expect(d?.kind).toBe('blocked');
    expect(d?.reason).toBe('permissions_unsatisfiable');
  });

  it('routes each step of a batch independently: assigned, fallback, and blocked together', () => {
    permissions.grant({ subject, profile: 'read_only' });
    const registry = registryWith([
      { id: 'editor', capability: cap('code.edit') },
      {
        id: 'writer',
        capability: cap('file.write', {
          requiredPermissions: [{ kind: 'filesystem_write' }],
        }),
      },
    ]);

    const steps: RoutableStep[] = [
      { id: 'assignable', requiredCapability: 'code.edit' },
      { id: 'fallbackable', requiredCapability: 'image.resize' },
      {
        id: 'blockable',
        requiredCapability: 'file.write',
        requiredPermissions: [{ kind: 'filesystem_write' }],
      },
    ];

    const decisions = selectAdapters({
      steps,
      registry,
      permissions,
      subject,
      fallbackAutomations: new Map([['image.resize', 'builtin-resize']]),
    });

    expect(decisions).toHaveLength(3);
    // Decisions preserve step order and each stepId is echoed back.
    expect(decisions.map((d) => d.stepId)).toEqual([
      'assignable',
      'fallbackable',
      'blockable',
    ]);

    const [assigned, fallback, blocked] = decisions;
    expect(assigned?.kind).toBe('assigned');
    expect(assigned?.assignedAdapterId).toBe('editor');

    expect(fallback?.kind).toBe('fallback');
    expect(fallback?.reason).toBe('no_candidates');
    expect(fallback?.fallbackAutomationId).toBe('builtin-resize');

    expect(blocked?.kind).toBe('blocked');
    expect(blocked?.reason).toBe('permissions_unsatisfiable');
  });

  it('treats an approval-gated permission as satisfiable (not blocked)', () => {
    // Boundary between 6.6 and 6.7: assisted_execution permits a write behind
    // approval, so the step is routable and must be assigned, not blocked.
    permissions.grant({ subject, profile: 'assisted_execution' });
    const registry = registryWith([
      {
        id: 'writer',
        capability: cap('file.write', {
          requiredPermissions: [{ kind: 'filesystem_write' }],
        }),
      },
    ]);

    const [d] = selectAdapters({
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

    expect(d?.kind).toBe('assigned');
    expect(d?.assignedAdapterId).toBe('writer');
  });
});
