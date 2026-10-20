// Unit tests for the planning DAG utilities (task 9.2).
//
// `topologicalSort` is the pure core of planning: it validates a decomposition
// and produces a deterministic dependency order, rejecting a cyclic graph
// (Requirement 5.8) as well as malformed decompositions (empty, duplicate ids,
// dangling dependencies). These tests cover the ordering guarantees and every
// rejection path in isolation, with no DB or routing involved.

import { describe, expect, it } from 'vitest';
import {
  DuplicateStepIdError,
  EmptyPlanError,
  PlaceholderPlanner,
  PLACEHOLDER_PLAN_CAPABILITY,
  PlanCycleError,
  PlanDependencyError,
  topologicalSort,
  type PlanDecomposition,
  type PlannedStep,
} from '@main/orchestrator/planner';

function step(
  id: string,
  dependsOn: string[] = [],
  overrides: Partial<PlannedStep> = {},
): PlannedStep {
  return {
    id,
    description: `step ${id}`,
    requiredCapability: 'cap',
    dependsOn,
    ...overrides,
  };
}

function plan(...steps: PlannedStep[]): PlanDecomposition {
  return { steps };
}

describe('topologicalSort — ordering (Requirement 5.4)', () => {
  it('orders a single dependency-free step as itself', () => {
    const order = topologicalSort(plan(step('a')));
    expect(order.map((s) => s.id)).toEqual(['a']);
  });

  it('places every step after all of its dependencies', () => {
    // a -> b -> c (c depends on b depends on a). The order must be a, b, c.
    const order = topologicalSort(
      plan(step('c', ['b']), step('b', ['a']), step('a')),
    );
    const ids = order.map((s) => s.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('handles a diamond DAG (a -> b, a -> c, b&c -> d)', () => {
    const order = topologicalSort(
      plan(
        step('d', ['b', 'c']),
        step('b', ['a']),
        step('c', ['a']),
        step('a'),
      ),
    );
    const ids = order.map((s) => s.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'));
    expect(ids).toHaveLength(4);
  });

  it('is deterministic: identical input yields an identical order', () => {
    const decomposition = plan(
      step('d', ['b', 'c']),
      step('b', ['a']),
      step('c', ['a']),
      step('a'),
    );
    const first = topologicalSort(decomposition).map((s) => s.id);
    const second = topologicalSort(decomposition).map((s) => s.id);
    expect(second).toEqual(first);
  });
});

describe('topologicalSort — rejection paths', () => {
  it('rejects a direct cycle (a -> b -> a) naming the cycle (Requirement 5.8)', () => {
    expect(() =>
      topologicalSort(plan(step('a', ['b']), step('b', ['a']))),
    ).toThrow(PlanCycleError);

    try {
      topologicalSort(plan(step('a', ['b']), step('b', ['a'])));
    } catch (err) {
      expect(err).toBeInstanceOf(PlanCycleError);
      const cycle = (err as PlanCycleError).cycle;
      // The cycle closes on the node it started from.
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect(cycle).toContain('a');
      expect(cycle).toContain('b');
    }
  });

  it('rejects a self-loop (a -> a)', () => {
    expect(() => topologicalSort(plan(step('a', ['a'])))).toThrow(
      PlanCycleError,
    );
  });

  it('rejects a longer cycle (a -> b -> c -> a)', () => {
    expect(() =>
      topologicalSort(
        plan(step('a', ['c']), step('b', ['a']), step('c', ['b'])),
      ),
    ).toThrow(PlanCycleError);
  });

  it('rejects an empty decomposition', () => {
    expect(() => topologicalSort(plan())).toThrow(EmptyPlanError);
  });

  it('rejects duplicate step ids', () => {
    expect(() => topologicalSort(plan(step('a'), step('a')))).toThrow(
      DuplicateStepIdError,
    );
  });

  it('rejects a dependency on an unknown step naming it', () => {
    try {
      topologicalSort(plan(step('a', ['ghost'])));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanDependencyError);
      expect((err as PlanDependencyError).stepId).toBe('a');
      expect((err as PlanDependencyError).missingDependency).toBe('ghost');
    }
  });
});

describe('PlaceholderPlanner', () => {
  it('decomposes any objective into a single dependency-free step', async () => {
    const planner = new PlaceholderPlanner();
    const decomposition = await planner.decompose({
      taskId: 't1',
      workspaceId: 'w1',
      objective: 'do the thing',
      contextRefs: [],
      acceptanceCriteria: [],
    });
    expect(decomposition.steps).toHaveLength(1);
    const [only] = decomposition.steps;
    expect(only?.requiredCapability).toBe(PLACEHOLDER_PLAN_CAPABILITY);
    expect(only?.dependsOn ?? []).toEqual([]);
  });

  it('is deterministic for the same request', async () => {
    const planner = new PlaceholderPlanner();
    const req = {
      taskId: 't1',
      workspaceId: 'w1',
      objective: 'stable',
      contextRefs: [],
      acceptanceCriteria: [],
    };
    const a = await planner.decompose(req);
    const b = await planner.decompose(req);
    expect(b).toEqual(a);
  });
});
