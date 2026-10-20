// Unit tests for the Workflow DAG engine (task 18.1, Requirement 15).
//
// Covers save/version (monotonic versions retaining prior versions, cycle and
// >500 rejection), retrieval of any version, testing against validation
// criteria with a pass/fail per criterion and the 60-second budget, and
// execution in dependency order with per-step history and enforcement of
// bounded loops, retries, timeouts, and the error-recovery policy.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import {
  type WorkflowCriterionResult,
  type WorkflowStep,
} from '@shared/domain';
import {
  type StepRunContext,
  type WorkflowStepRunner,
  type WorkflowValidator,
  WorkflowEngine,
  WorkflowNotFoundError,
  WorkflowValidationError,
} from '@main/orchestrator/workflow-engine';
import { WorkflowCycleError, WorkflowSizeError } from '@main/orchestrator/workflow-graph';

let workDir: string;
let store: SqliteStore;
let engine: WorkflowEngine;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-workflow-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  engine = new WorkflowEngine(store);
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function step(
  id: string,
  dependsOn: string[] = [],
  overrides: Partial<WorkflowStep> = {},
): WorkflowStep {
  return {
    id,
    description: `step ${id}`,
    requiredCapability: 'cap',
    dependsOn,
    ...overrides,
  };
}

/** A runner that fails exactly the named step ids on the given attempt. */
function scriptedRunner(script: {
  failStepUntilAttempt?: Record<string, number>;
  failStepAlways?: string[];
  durationMs?: Record<string, number>;
  recorded?: string[];
}): WorkflowStepRunner {
  return {
    run(ctx: StepRunContext) {
      script.recorded?.push(ctx.step.id);
      const duration = script.durationMs?.[ctx.step.id] ?? 1;
      if (script.failStepAlways?.includes(ctx.step.id)) {
        return Promise.resolve({ ok: false, durationMs: duration });
      }
      const until = script.failStepUntilAttempt?.[ctx.step.id];
      if (until !== undefined && ctx.attempt < until) {
        return Promise.resolve({ ok: false, durationMs: duration });
      }
      return Promise.resolve({ ok: true, durationMs: duration });
    },
  };
}

describe('WorkflowEngine.save — versioning (Requirement 15.3)', () => {
  it('mints a new workflow at version 1', () => {
    const wf = engine.save({ name: 'Flow', steps: [step('a')] });
    expect(wf.version).toBe(1);
    expect(wf.workflowId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('assigns monotonically increasing versions on edit, retaining priors', () => {
    const v1 = engine.save({ name: 'Flow', steps: [step('a')] });
    const v2 = engine.save({
      workflowId: v1.workflowId,
      name: 'Flow',
      steps: [step('a'), step('b', ['a'])],
    });
    const v3 = engine.save({
      workflowId: v1.workflowId,
      name: 'Flow',
      steps: [step('a')],
    });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);

    // Every prior version is retrievable with its own graph.
    expect(engine.get(v1.workflowId, 1).steps).toHaveLength(1);
    expect(engine.get(v1.workflowId, 2).steps).toHaveLength(2);
    expect(engine.listVersions(v1.workflowId).map((w) => w.version)).toEqual([
      1, 2, 3,
    ]);
    // get() without a version returns the latest.
    expect(engine.get(v1.workflowId).version).toBe(3);
  });

  it('rejects editing a workflow id that was never created', () => {
    expect(() =>
      engine.save({ workflowId: 'ghost', name: 'Flow', steps: [step('a')] }),
    ).toThrow(WorkflowNotFoundError);
  });

  it('rejects a cyclic graph and persists nothing (Requirement 15.2)', () => {
    expect(() =>
      engine.save({ name: 'Flow', steps: [step('a', ['b']), step('b', ['a'])] }),
    ).toThrow(WorkflowCycleError);
  });

  it('rejects a graph over 500 steps (Requirement 15.2)', () => {
    const steps: WorkflowStep[] = [];
    for (let i = 0; i < 501; i += 1) {
      steps.push(step(`s${i}`));
    }
    expect(() => engine.save({ name: 'Flow', steps })).toThrow(WorkflowSizeError);
  });

  it('rejects an empty name', () => {
    expect(() => engine.save({ name: '  ', steps: [step('a')] })).toThrow(
      WorkflowValidationError,
    );
  });

  it('rejects a compensate recovery that names a missing step', () => {
    expect(() =>
      engine.save({
        name: 'Flow',
        steps: [step('a')],
        errorRecovery: { kind: 'compensate', compensateWith: 'nope' },
      }),
    ).toThrow(WorkflowValidationError);
  });
});

describe('WorkflowEngine.test — validation criteria (Requirement 15.4)', () => {
  it('reports a pass/fail per criterion', async () => {
    const wf = engine.save({
      name: 'Flow',
      steps: [step('a')],
      validationCriteria: [
        { id: 'c1', description: 'first' },
        { id: 'c2', description: 'second' },
      ],
    });
    const validator: WorkflowValidator = {
      evaluate(): Promise<WorkflowCriterionResult[]> {
        return Promise.resolve([
          { criterionId: 'c1', outcome: 'pass' },
          { criterionId: 'c2', outcome: 'fail', detail: 'nope' },
        ]);
      },
    };
    const report = await engine.test(wf.workflowId, validator);
    expect(report.results).toEqual([
      { criterionId: 'c1', outcome: 'pass' },
      { criterionId: 'c2', outcome: 'fail', detail: 'nope' },
    ]);
    expect(report.version).toBe(1);
  });
});

describe('WorkflowEngine.run — execution (Requirements 15.5-15.7)', () => {
  it('executes steps in dependency order recording per-step history', async () => {
    const wf = engine.save({
      name: 'Flow',
      steps: [step('c', ['b']), step('b', ['a']), step('a')],
    });
    const recorded: string[] = [];
    const result = await engine.run(wf.workflowId, scriptedRunner({ recorded }));
    expect(result.status).toBe('completed');
    expect(recorded).toEqual(['a', 'b', 'c']);
    expect(result.history.map((h) => h.stepId)).toEqual(['a', 'b', 'c']);
    for (const entry of result.history) {
      expect(entry.outcome).toBe('succeeded');
      expect(entry.startedAt).toBeDefined();
      expect(entry.endedAt).toBeDefined();
    }
  });

  it('retries a failing step up to its max retry count then succeeds', async () => {
    const wf = engine.save({
      name: 'Flow',
      steps: [step('a', [], { policy: { maxRetries: 2, timeoutMs: 1000 } })],
    });
    // Fails on attempts 1 and 2, succeeds on attempt 3.
    const result = await engine.run(
      wf.workflowId,
      scriptedRunner({ failStepUntilAttempt: { a: 3 } }),
    );
    expect(result.status).toBe('completed');
    const entry = result.history[0];
    expect(entry?.outcome).toBe('succeeded');
    expect(entry?.attempts).toBe(3);
  });

  it('aborts the run when a step exhausts retries under the default abort policy', async () => {
    const wf = engine.save({
      name: 'Flow',
      steps: [
        step('a', [], { policy: { maxRetries: 1, timeoutMs: 1000 } }),
        step('b', ['a']),
      ],
    });
    const recorded: string[] = [];
    const result = await engine.run(
      wf.workflowId,
      scriptedRunner({ failStepAlways: ['a'], recorded }),
    );
    expect(result.status).toBe('failed');
    const entry = result.history[0];
    expect(entry?.outcome).toBe('failed');
    expect(entry?.attempts).toBe(2); // initial + 1 retry
    expect(entry?.recoveryAction).toBe('abort');
    // b never runs because the run aborted.
    expect(recorded).not.toContain('b');
  });

  it('continues past a failed step under a continue recovery policy', async () => {
    const wf = engine.save({
      name: 'Flow',
      steps: [
        step('a', [], { errorRecovery: { kind: 'continue' } }),
        step('b'),
      ],
      errorRecovery: { kind: 'continue' },
    });
    const recorded: string[] = [];
    const result = await engine.run(
      wf.workflowId,
      scriptedRunner({ failStepAlways: ['a'], recorded }),
    );
    expect(result.status).toBe('completed');
    expect(recorded).toContain('b');
    const aEntry = result.history.find((h) => h.stepId === 'a');
    expect(aEntry?.outcome).toBe('failed');
    expect(aEntry?.recoveryAction).toBe('continue');
  });

  it('runs a compensation step on failure under a compensate policy', async () => {
    const wf = engine.save({
      name: 'Flow',
      steps: [
        step('a', [], { errorRecovery: { kind: 'compensate', compensateWith: 'comp' } }),
        step('comp'),
      ],
    });
    const recorded: string[] = [];
    const result = await engine.run(
      wf.workflowId,
      scriptedRunner({ failStepAlways: ['a'], recorded }),
    );
    expect(recorded).toContain('comp');
    const aEntry = result.history.find((h) => h.stepId === 'a');
    expect(aEntry?.recoveryAction).toBe('compensate');
  });

  it('aborts an attempt that exceeds its timeout and retries within budget', async () => {
    const wf = engine.save({
      name: 'Flow',
      steps: [step('a', [], { policy: { maxRetries: 0, timeoutMs: 100 } })],
    });
    // Single attempt reports 500ms > 100ms timeout: counts as a failure.
    const result = await engine.run(
      wf.workflowId,
      scriptedRunner({ durationMs: { a: 500 } }),
    );
    expect(result.status).toBe('failed');
    const entry = result.history[0];
    expect(entry?.outcome).toBe('failed');
    expect(entry?.detail).toMatch(/timeout/);
  });

  it('terminates a bounded loop at its max iteration count', async () => {
    const wf = engine.save({
      name: 'Flow',
      steps: [
        step('a', [], { loop: { continueWhile: 'keepGoing', maxIterations: 3 } }),
      ],
    });
    const recorded: string[] = [];
    // keepGoing stays true, so only the maxIterations bound stops the loop.
    const result = await engine.run(
      wf.workflowId,
      scriptedRunner({ recorded }),
      { variables: { keepGoing: true } },
    );
    expect(result.status).toBe('completed');
    const aIterations = result.history.filter((h) => h.stepId === 'a');
    expect(aIterations).toHaveLength(3);
    expect(aIterations.map((h) => h.iteration)).toEqual([1, 2, 3]);
    expect(recorded.filter((id) => id === 'a')).toHaveLength(3);
  });

  it('persists the run and its step history', async () => {
    const wf = engine.save({ name: 'Flow', steps: [step('a'), step('b', ['a'])] });
    await engine.run(wf.workflowId, scriptedRunner({}));
    const runRow = store.db
      .prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_id = ?')
      .get(wf.workflowId) as { n: number };
    expect(runRow.n).toBe(1);
    const historyRow = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM workflow_step_history h
         JOIN workflow_runs r ON r.id = h.run_id
         WHERE r.workflow_id = ?`,
      )
      .get(wf.workflowId) as { n: number };
    expect(historyRow.n).toBe(2);
  });
});
