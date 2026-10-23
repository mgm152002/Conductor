import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fc } from '../helpers/fast-check';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { SelfLearningEngine } from '@main/domain/self-learning-service';
import {
  MIN_IMPROVEMENT_EXAMPLES,
  type ImprovementKind,
  type PerformanceBaseline,
  type RecordTaskOutcomeInput,
} from '@shared/domain';

// ---------------------------------------------------------------------------
// Property 10: No autonomous core-code modification
// Validates: Requirement 18.6
//
// The dedicated P10 property test. The self-learning engine may propose
// skills / routing rules / memory / workflow versions for approval, but it must
// never autonomously edit core executable code. We exercise the engine across
// random histories, candidates, and projected metrics, and assert two
// invariants that together express "never autonomously modifies core code":
//
//  (a) Allowed-kind invariant — every proposal the engine ever creates has a
//      `kind` drawn strictly from the four learned-artifact kinds. There is no
//      `core_code` kind; a proposal can only ever name a learned artifact, so
//      the engine has no representable path to edit executable code.
//
//  (b) No-autonomous-adoption invariant — the engine never advances a proposal
//      past `proposed` on its own. Evaluation (even when it classifies a
//      candidate as a demonstrated improvement) leaves every proposal in
//      `proposed` status; adoption happens only through the explicit approve()
//      call. So nothing is ever adopted — code or otherwise — without the user.
// ---------------------------------------------------------------------------

const ALLOWED_KINDS: readonly ImprovementKind[] = [
  'skill',
  'routing_rule',
  'memory',
  'workflow_version',
];

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-learning-p10-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

const kindArb = fc.constantFrom<ImprovementKind>(...ALLOWED_KINDS);

const outcomeArb: fc.Arbitrary<Omit<RecordTaskOutcomeInput, 'comparabilityKey'>> =
  fc.record({
    taskId: fc.uuid(),
    result: fc.constantFrom<'success' | 'failure'>('success', 'failure'),
    durationMs: fc.integer({ min: 0, max: 60_000 }),
    failureCount: fc.integer({ min: 0, max: 5 }),
    retryCount: fc.integer({ min: 0, max: 5 }),
    verificationResults: fc.constant([]),
    toolUsage: fc.array(fc.string({ minLength: 1, maxLength: 8 }), {
      maxLength: 3,
    }),
  });

const baselineArb: fc.Arbitrary<PerformanceBaseline> = fc.record({
  sampleSize: fc.integer({ min: 0, max: 20 }),
  failureRate: fc.double({ min: 0, max: 1, noNaN: true }),
  meanDurationMs: fc.double({ min: 0, max: 60_000, noNaN: true }),
});

describe('P10 — no autonomous core-code modification', () => {
  it('every proposal the engine creates is a learned-artifact kind, and none is adopted without approval', () => {
    fc.assert(
      fc.property(
        // A batch of comparable prior outcomes (varying length, spanning below
        // and above the demonstrated-improvement threshold).
        fc.array(outcomeArb, { minLength: 0, maxLength: MIN_IMPROVEMENT_EXAMPLES + 5 }),
        kindArb,
        baselineArb,
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.jsonValue(),
        (priors, kind, projected, summary, payload) => {
          const engine = new SelfLearningEngine(store, audit);
          const comparabilityKey = `k-${Math.random().toString(36).slice(2)}`;

          for (const o of priors) {
            engine.record({ ...o, comparabilityKey });
          }

          const evaluation = engine.evaluate(
            { comparabilityKey, kind, summary, payload },
            projected,
          );

          // (a) Any proposal produced names an allowed learned-artifact kind.
          if (evaluation.classification === 'demonstrated') {
            expect(ALLOWED_KINDS).toContain(evaluation.proposal.kind);
          }

          // (a) Holds for every persisted proposal too, not just the returned one.
          for (const proposal of engine.listProposals()) {
            expect(ALLOWED_KINDS).toContain(proposal.kind);
            // (b) The engine never autonomously advances past `proposed`:
            // evaluation adopts nothing on its own.
            expect(proposal.status).toBe('proposed');
          }

          // (b) No adoption audit event is emitted without an approve() call.
          const adopted = audit
            .list()
            .filter((e) => e.action === 'improvement_approved');
          expect(adopted).toHaveLength(0);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('an evaluated candidate is adopted only through an explicit approval', () => {
    fc.assert(
      fc.property(
        kindArb,
        fc.string({ minLength: 1, maxLength: 20 }),
        (kind, summary) => {
          const engine = new SelfLearningEngine(store, audit);
          const comparabilityKey = `k-${Math.random().toString(36).slice(2)}`;

          // A baseline that guarantees a demonstrated improvement: many failing,
          // slow priors vs a perfect, fast projection.
          for (let i = 0; i < MIN_IMPROVEMENT_EXAMPLES; i += 1) {
            engine.record({
              taskId: `t${i}`,
              comparabilityKey,
              result: 'failure',
              durationMs: 5000,
              failureCount: 1,
              retryCount: 1,
              verificationResults: [],
              toolUsage: [],
            });
          }

          const evaluation = engine.evaluate(
            { comparabilityKey, kind, summary, payload: null },
            { sampleSize: MIN_IMPROVEMENT_EXAMPLES, failureRate: 0, meanDurationMs: 100 },
          );
          expect(evaluation.classification).toBe('demonstrated');
          if (evaluation.classification !== 'demonstrated') return false;

          // Still `proposed` right after evaluation — nothing adopted yet.
          expect(engine.getProposal(evaluation.proposal.id)!.status).toBe('proposed');

          // Only the explicit approval moves it to adopted.
          const approved = engine.approve(evaluation.proposal.id);
          expect(approved.status).toBe('approved');
          expect(ALLOWED_KINDS).toContain(approved.kind);
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});
