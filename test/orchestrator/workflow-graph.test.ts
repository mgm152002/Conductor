// Unit tests for the Workflow DAG graph validator (task 18.1, Requirement 15.2).
//
// `validateWorkflowGraph` is the pure core of the Workflow_Engine: it validates
// a workflow's steps-and-dependencies graph and produces a deterministic
// dependency order, rejecting cycles (naming the offending steps), graphs over
// 500 steps, dangling dependencies, duplicate ids, and empty graphs. These
// tests cover the ordering guarantees and every rejection path in isolation.

import { describe, expect, it } from 'vitest';
import { MAX_WORKFLOW_STEPS, type WorkflowStep } from '@shared/domain';
import {
  DuplicateWorkflowStepIdError,
  EmptyWorkflowError,
  validateWorkflowGraph,
  WorkflowCycleError,
  WorkflowDependencyError,
  WorkflowSizeError,
} from '@main/orchestrator/workflow-graph';

function step(id: string, dependsOn: string[] = []): WorkflowStep {
  return {
    id,
    description: `step ${id}`,
    requiredCapability: 'cap',
    dependsOn,
  };
}

describe('validateWorkflowGraph — ordering (Requirement 15.5)', () => {
  it('orders a single dependency-free step as itself', () => {
    const order = validateWorkflowGraph([step('a')]);
    expect(order.map((s) => s.id)).toEqual(['a']);
  });

  it('places every step after all of its dependencies', () => {
    const order = validateWorkflowGraph([
      step('c', ['b']),
      step('b', ['a']),
      step('a'),
    ]);
    const ids = order.map((s) => s.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('handles a diamond DAG (a -> b, a -> c, b&c -> d)', () => {
    const order = validateWorkflowGraph([
      step('d', ['b', 'c']),
      step('b', ['a']),
      step('c', ['a']),
      step('a'),
    ]);
    const ids = order.map((s) => s.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'));
    expect(ids).toHaveLength(4);
  });

  it('is deterministic: identical input yields an identical order', () => {
    const steps = [
      step('d', ['b', 'c']),
      step('b', ['a']),
      step('c', ['a']),
      step('a'),
    ];
    const first = validateWorkflowGraph(steps).map((s) => s.id);
    const second = validateWorkflowGraph(steps).map((s) => s.id);
    expect(second).toEqual(first);
  });

  it('accepts a graph of exactly 500 steps (Requirement 15.2)', () => {
    const steps: WorkflowStep[] = [];
    for (let i = 0; i < MAX_WORKFLOW_STEPS; i += 1) {
      steps.push(step(`s${i}`, i === 0 ? [] : [`s${i - 1}`]));
    }
    expect(validateWorkflowGraph(steps)).toHaveLength(MAX_WORKFLOW_STEPS);
  });
});

describe('validateWorkflowGraph — rejection paths (Requirement 15.2)', () => {
  it('rejects a graph over 500 steps naming the count and limit', () => {
    const steps: WorkflowStep[] = [];
    for (let i = 0; i < MAX_WORKFLOW_STEPS + 1; i += 1) {
      steps.push(step(`s${i}`));
    }
    try {
      validateWorkflowGraph(steps);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSizeError);
      expect((err as WorkflowSizeError).stepCount).toBe(MAX_WORKFLOW_STEPS + 1);
      expect((err as WorkflowSizeError).limit).toBe(MAX_WORKFLOW_STEPS);
    }
  });

  it('rejects a direct cycle (a -> b -> a) naming the cycle', () => {
    try {
      validateWorkflowGraph([step('a', ['b']), step('b', ['a'])]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowCycleError);
      const cycle = (err as WorkflowCycleError).cycle;
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect(cycle).toContain('a');
      expect(cycle).toContain('b');
    }
  });

  it('rejects a self-loop (a -> a)', () => {
    expect(() => validateWorkflowGraph([step('a', ['a'])])).toThrow(
      WorkflowCycleError,
    );
  });

  it('rejects a longer cycle (a -> b -> c -> a)', () => {
    expect(() =>
      validateWorkflowGraph([
        step('a', ['c']),
        step('b', ['a']),
        step('c', ['b']),
      ]),
    ).toThrow(WorkflowCycleError);
  });

  it('rejects an empty workflow', () => {
    expect(() => validateWorkflowGraph([])).toThrow(EmptyWorkflowError);
  });

  it('rejects duplicate step ids', () => {
    expect(() => validateWorkflowGraph([step('a'), step('a')])).toThrow(
      DuplicateWorkflowStepIdError,
    );
  });

  it('rejects a dependency on an unknown step naming it', () => {
    try {
      validateWorkflowGraph([step('a', ['ghost'])]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowDependencyError);
      expect((err as WorkflowDependencyError).stepId).toBe('a');
      expect((err as WorkflowDependencyError).missingDependency).toBe('ghost');
    }
  });
});
