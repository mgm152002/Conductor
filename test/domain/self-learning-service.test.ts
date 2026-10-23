import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import {
  ProposalNotFoundError,
  ProposalStateError,
  SelfLearningEngine,
} from '@main/domain/self-learning-service';
import {
  MIN_IMPROVEMENT_EXAMPLES,
  MIN_REGRESSION_TASKS,
  type ImprovementCandidate,
  type PerformanceBaseline,
  type RecordTaskOutcomeInput,
} from '@shared/domain';

// Unit tests for Requirement 18 (Self-learning engine):
//   18.1 — record per-task outcome/duration/failure/retry/verification/tools/feedback
//   18.2 — demonstrated improvement only on a measurable reduction across ≥5
//          comparable examples; otherwise correlation, withheld
//   18.3 — present a demonstrated improvement for approval; no adoption until approved
//   18.4 — a rejected proposal is discarded and never adopted
//   18.5 — roll back an adopted improvement that regresses across ≥3 subsequent
//          comparable tasks and notify the user
//   18.6 / Property 10 — never a core-code kind (see self-learning.p10.test.ts)

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;

let clockMs: number;
const now = () => clockMs;
/** Advance the test clock so append-order timestamps are distinct. */
const tick = (ms = 1000): number => (clockMs += ms);

const KEY = 'summarize-doc';

function newEngine(): SelfLearningEngine {
  return new SelfLearningEngine(store, audit, now);
}

function outcome(
  overrides: Partial<RecordTaskOutcomeInput> = {},
): RecordTaskOutcomeInput {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    comparabilityKey: KEY,
    result: 'success',
    durationMs: 1000,
    failureCount: 0,
    retryCount: 0,
    verificationResults: [{ criterion: 'all sections covered', passed: true }],
    toolUsage: ['text.summarize'],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ImprovementCandidate> = {},
): ImprovementCandidate {
  return {
    comparabilityKey: KEY,
    kind: 'skill',
    summary: 'Use a two-pass summary strategy',
    payload: { strategy: 'two-pass' },
    ...overrides,
  };
}

/** Seed `count` comparable baseline outcomes with the given shape. */
function seedBaseline(
  engine: SelfLearningEngine,
  count: number,
  shape: Partial<RecordTaskOutcomeInput> = {},
): void {
  for (let i = 0; i < count; i += 1) {
    engine.record(outcome(shape));
    tick();
  }
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-learning-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  clockMs = Date.parse('2024-01-01T00:00:00.000Z');
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('SelfLearningEngine — record outcomes (18.1)', () => {
  it('records every observed field and persists it', () => {
    const engine = newEngine();
    const recorded = engine.record(
      outcome({
        taskId: 't1',
        result: 'failure',
        durationMs: 4200,
        failureCount: 2,
        retryCount: 1,
        verificationResults: [
          { criterion: 'a', passed: true },
          { criterion: 'b', passed: false },
        ],
        toolUsage: ['text.summarize', 'web.fetch'],
        userFeedback: 'too terse',
      }),
    );

    const fetched = engine.getOutcome(recorded.id);
    expect(fetched).toBeDefined();
    expect(fetched!.taskId).toBe('t1');
    expect(fetched!.result).toBe('failure');
    expect(fetched!.durationMs).toBe(4200);
    expect(fetched!.failureCount).toBe(2);
    expect(fetched!.retryCount).toBe(1);
    expect(fetched!.verificationResults).toHaveLength(2);
    expect(fetched!.toolUsage).toEqual(['text.summarize', 'web.fetch']);
    expect(fetched!.userFeedback).toBe('too terse');
  });

  it('appends an audit event for each recorded outcome', () => {
    const engine = newEngine();
    engine.record(outcome({ taskId: 't1' }));
    const events = audit
      .list()
      .filter((e) => e.action === 'task_outcome_recorded');
    expect(events).toHaveLength(1);
    expect(events[0]!.target).toBe('t1');
  });
});

describe('SelfLearningEngine — evaluate candidate (18.2/18.3)', () => {
  const better: PerformanceBaseline = {
    sampleSize: MIN_IMPROVEMENT_EXAMPLES,
    failureRate: 0,
    meanDurationMs: 500,
  };

  it('withholds as correlation when fewer than the minimum comparable examples exist', () => {
    const engine = newEngine();
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES - 1, {
      result: 'failure',
      durationMs: 2000,
    });

    const evaluation = engine.evaluate(candidate(), better);
    expect(evaluation.classification).toBe('correlation');
    if (evaluation.classification === 'correlation') {
      expect(evaluation.reason).toBe('insufficient_examples');
    }
    // No proposal was created — nothing is surfaced for approval.
    expect(engine.listProposals('proposed')).toHaveLength(0);
  });

  it('withholds as correlation when neither failure rate nor duration falls', () => {
    const engine = newEngine();
    // Baseline: perfect and fast already.
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'success',
      durationMs: 500,
    });
    // Candidate projects no better than baseline.
    const noBetter: PerformanceBaseline = {
      sampleSize: MIN_IMPROVEMENT_EXAMPLES,
      failureRate: 0,
      meanDurationMs: 500,
    };

    const evaluation = engine.evaluate(candidate(), noBetter);
    expect(evaluation.classification).toBe('correlation');
    if (evaluation.classification === 'correlation') {
      expect(evaluation.reason).toBe('no_measurable_improvement');
    }
    expect(engine.listProposals('proposed')).toHaveLength(0);
  });

  it('classifies as demonstrated on a measurable failure-rate reduction across enough examples', () => {
    const engine = newEngine();
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'failure',
      durationMs: 2000,
    });

    const evaluation = engine.evaluate(candidate(), better);
    expect(evaluation.classification).toBe('demonstrated');
    if (evaluation.classification === 'demonstrated') {
      expect(evaluation.baseline.sampleSize).toBe(MIN_IMPROVEMENT_EXAMPLES);
      expect(evaluation.baseline.failureRate).toBe(1);
      expect(evaluation.proposal.status).toBe('proposed');
      expect(evaluation.proposal.kind).toBe('skill');
    }
    // Exactly one proposal surfaced for approval, in proposed status.
    expect(engine.listProposals('proposed')).toHaveLength(1);
  });

  it('classifies as demonstrated on a duration reduction even when failure rate is unchanged', () => {
    const engine = newEngine();
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'success',
      durationMs: 2000,
    });
    const fasterSameFailures: PerformanceBaseline = {
      sampleSize: MIN_IMPROVEMENT_EXAMPLES,
      failureRate: 0,
      meanDurationMs: 800,
    };

    const evaluation = engine.evaluate(candidate(), fasterSameFailures);
    expect(evaluation.classification).toBe('demonstrated');
  });

  it('takes no adoption action on evaluation — the proposal stays proposed', () => {
    const engine = newEngine();
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'failure',
      durationMs: 2000,
    });
    const evaluation = engine.evaluate(candidate(), better);
    expect(evaluation.classification).toBe('demonstrated');
    if (evaluation.classification === 'demonstrated') {
      const stored = engine.getProposal(evaluation.proposal.id)!;
      expect(stored.status).toBe('proposed');
      expect(stored.resolvedAt).toBeUndefined();
    }
  });
});

describe('SelfLearningEngine — approve / reject (18.3/18.4)', () => {
  const better: PerformanceBaseline = {
    sampleSize: MIN_IMPROVEMENT_EXAMPLES,
    failureRate: 0,
    meanDurationMs: 500,
  };

  function demonstratedProposalId(engine: SelfLearningEngine): string {
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'failure',
      durationMs: 2000,
    });
    const evaluation = engine.evaluate(candidate(), better);
    if (evaluation.classification !== 'demonstrated') {
      throw new Error('expected a demonstrated improvement');
    }
    return evaluation.proposal.id;
  }

  it('approval adopts the improvement (status approved) and audits it', () => {
    const engine = newEngine();
    const id = demonstratedProposalId(engine);
    const approved = engine.approve(id);
    expect(approved.status).toBe('approved');
    expect(approved.resolvedAt).toBeDefined();
    expect(
      audit.list().some((e) => e.action === 'improvement_approved'),
    ).toBe(true);
  });

  it('rejection discards the improvement (status rejected) and never adopts it', () => {
    const engine = newEngine();
    const id = demonstratedProposalId(engine);
    const rejected = engine.reject(id);
    expect(rejected.status).toBe('rejected');
    expect(engine.listProposals('approved')).toHaveLength(0);
    expect(
      audit.list().some((e) => e.action === 'improvement_rejected'),
    ).toBe(true);
  });

  it('rejects approving/rejecting a proposal that is not proposed', () => {
    const engine = newEngine();
    const id = demonstratedProposalId(engine);
    engine.approve(id);
    expect(() => engine.approve(id)).toThrow(ProposalStateError);
    expect(() => engine.reject(id)).toThrow(ProposalStateError);
  });

  it('throws for an unknown proposal id', () => {
    const engine = newEngine();
    expect(() => engine.approve('nope')).toThrow(ProposalNotFoundError);
  });
});

describe('SelfLearningEngine — regression tracking + rollback (18.5)', () => {
  const better: PerformanceBaseline = {
    sampleSize: MIN_IMPROVEMENT_EXAMPLES,
    failureRate: 0,
    meanDurationMs: 500,
  };

  function adoptedProposalId(engine: SelfLearningEngine): string {
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'failure',
      durationMs: 2000,
    });
    const evaluation = engine.evaluate(candidate(), better);
    if (evaluation.classification !== 'demonstrated') {
      throw new Error('expected a demonstrated improvement');
    }
    return engine.approve(evaluation.proposal.id).id;
  }

  it('reports monitoring until enough subsequent comparable tasks exist', () => {
    const engine = newEngine();
    const id = adoptedProposalId(engine);
    // Fewer than the minimum subsequent tasks attributed to the improvement.
    for (let i = 0; i < MIN_REGRESSION_TASKS - 1; i += 1) {
      engine.record(outcome({ result: 'failure', improvementId: id }));
      tick();
    }
    const result = engine.checkRegression(id);
    expect(result.status).toBe('monitoring');
  });

  it('rolls back when subsequent comparable tasks regress and notifies the user', () => {
    const engine = newEngine();
    // Build a clean baseline: all success, fast — so a regression is possible.
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'success',
      durationMs: 1000,
    });
    const projected: PerformanceBaseline = {
      sampleSize: MIN_IMPROVEMENT_EXAMPLES,
      failureRate: 0,
      meanDurationMs: 600,
    };
    const evaluation = engine.evaluate(candidate(), projected);
    expect(evaluation.classification).toBe('demonstrated');
    if (evaluation.classification !== 'demonstrated') return;
    const id = engine.approve(evaluation.proposal.id).id;

    // Subsequent comparable tasks regress (higher failure rate than baseline 0).
    for (let i = 0; i < MIN_REGRESSION_TASKS; i += 1) {
      engine.record(outcome({ result: 'failure', durationMs: 3000, improvementId: id }));
      tick();
    }

    const result = engine.checkRegression(id);
    expect(result.status).toBe('rolled_back');
    expect(engine.getProposal(id)!.status).toBe('rolled_back');
    expect(engine.getProposal(id)!.rolledBackAt).toBeDefined();
    expect(
      audit.list().some((e) => e.action === 'improvement_rolled_back'),
    ).toBe(true);
  });

  it('stays healthy when subsequent comparable tasks do not regress', () => {
    const engine = newEngine();
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'failure',
      durationMs: 2000,
    });
    const projected: PerformanceBaseline = {
      sampleSize: MIN_IMPROVEMENT_EXAMPLES,
      failureRate: 0,
      meanDurationMs: 500,
    };
    const evaluation = engine.evaluate(candidate(), projected);
    expect(evaluation.classification).toBe('demonstrated');
    if (evaluation.classification !== 'demonstrated') return;
    const id = engine.approve(evaluation.proposal.id).id;

    // Subsequent tasks are better than the (1.0 failure, 2000ms) baseline.
    for (let i = 0; i < MIN_REGRESSION_TASKS; i += 1) {
      engine.record(outcome({ result: 'success', durationMs: 400, improvementId: id }));
      tick();
    }

    const result = engine.checkRegression(id);
    expect(result.status).toBe('healthy');
    expect(engine.getProposal(id)!.status).toBe('approved');
  });

  it('refuses a regression check for a proposal that was never adopted', () => {
    const engine = newEngine();
    seedBaseline(engine, MIN_IMPROVEMENT_EXAMPLES, {
      result: 'failure',
      durationMs: 2000,
    });
    const evaluation = engine.evaluate(candidate(), better);
    if (evaluation.classification !== 'demonstrated') return;
    expect(() => engine.checkRegression(evaluation.proposal.id)).toThrow(
      ProposalStateError,
    );
  });
});
