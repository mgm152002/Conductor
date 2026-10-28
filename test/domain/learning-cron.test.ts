import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { SettingsService } from '@main/domain/settings-service';
import { WorkspaceService } from '@main/domain/workspace-service';
import { SelfLearningEngine } from '@main/domain/self-learning-service';
import { LearningLoop } from '@main/domain/learning-loop';
import { LearningCronService } from '@main/domain/learning-cron';
import { parseRoutingSuggestions, type LearningAnalyzer, type RoutingSuggestion } from '@main/domain/learning-analyzer';
import { LEARNING_INTERVAL_MS } from '@shared/learning-contract';

let dir: string;
let store: SqliteStore;
let audit: AuditLog;
let engine: SelfLearningEngine;
let loop: LearningLoop;
let settings: SettingsService;
let analyzerInput: Parameters<LearningAnalyzer['analyze']>[0] | undefined;

function cronWith(suggestions: RoutingSuggestion[]): LearningCronService {
  const analyzer: LearningAnalyzer = {
    analyze: async (input) => { analyzerInput = input; return suggestions; },
  };
  return new LearningCronService({
    settings, audit, learningLoop: loop, engine, analyzer,
    availableAgents: () => ['codex', 'claude-code'],
  });
}

function seed(): void {
  let n = 0;
  const record = (adapter: string, result: 'success' | 'failure', durationMs: number): void => {
    engine.record({
      taskId: `task-${n += 1}`, comparabilityKey: 'capability:objective.fulfill', result, durationMs,
      failureCount: result === 'failure' ? 1 : 0, retryCount: 0, verificationResults: [], toolUsage: [adapter],
    });
  };
  for (let i = 0; i < 3; i += 1) record('claude-code', 'failure', 10_000);
  for (let i = 0; i < 3; i += 1) record('codex', 'success', 5_000);
}

const WINNER: RoutingSuggestion = {
  comparabilityKey: 'capability:objective.fulfill', capability: 'objective.fulfill',
  preferAdapterId: 'codex', summary: 'Prefer codex: 100% success over 3 runs',
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-learning-cron-'));
  store = new SqliteStore(join(dir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  settings = new SettingsService(store, new WorkspaceService(store));
  engine = new SelfLearningEngine(store, audit);
  loop = new LearningLoop(store, engine);
  analyzerInput = undefined;
});

afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('LearningCronService', () => {
  it('runs on a 5-minute interval and skips until the user approves an LLM', async () => {
    seed();
    const cron = cronWith([WINNER]);
    expect(cron.getConfig().intervalMs).toBe(LEARNING_INTERVAL_MS);
    expect(LEARNING_INTERVAL_MS).toBe(5 * 60_000);
    const run = await cron.runNow('cron');
    expect(run).toMatchObject({ status: 'skipped', reason: 'no_approved_llm' });
    expect(engine.listProposals()).toHaveLength(0);
    expect(analyzerInput).toBeUndefined();
  });

  it('manual mode: approved LLM reviews stats + logs and routing waits for user approval', async () => {
    seed();
    const cron = cronWith([WINNER]);
    cron.setConfig({ analyzerAgentId: 'codex' });
    const run = await cron.runNow('manual');
    expect(run.status).toBe('completed');
    expect(run.proposalIds).toHaveLength(1);
    expect(run.autoApprovedIds).toHaveLength(0);
    // The LLM was fed success rates and log actions.
    expect(analyzerInput?.statsByKey[0]?.agents.map((a) => a.adapterId).sort()).toEqual(['claude-code', 'codex']);
    expect(analyzerInput?.recentLogs.length).toBeGreaterThan(0);
    const proposal = engine.getProposal(run.proposalIds[0]!)!;
    expect(proposal.status).toBe('proposed');
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(0.5);
    engine.approve(proposal.id);
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(1);
  });

  it('auto mode: demonstrated routing is approved and applied automatically', async () => {
    seed();
    const cron = cronWith([WINNER]);
    cron.setConfig({ analyzerAgentId: 'claude-code', mode: 'auto' });
    const run = await cron.runNow('cron');
    expect(run.autoApprovedIds).toEqual(run.proposalIds);
    expect(engine.getProposal(run.proposalIds[0]!)!.status).toBe('approved');
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(1);
    expect(audit.list().some((e) => e.action === 'learning_auto_approved')).toBe(true);
  });

  it('drops LLM suggestions that contradict the measured success rates', async () => {
    seed();
    const cron = cronWith([{ ...WINNER, preferAdapterId: 'claude-code', summary: 'Prefer the loser' }]);
    cron.setConfig({ analyzerAgentId: 'codex' });
    const run = await cron.runNow('manual');
    expect(run.status).toBe('completed');
    expect(run.proposalIds).toHaveLength(0);
    expect(engine.listProposals()).toHaveLength(0);
  });

  it('cron skips when there are no new outcomes since the last run', async () => {
    seed();
    const cron = cronWith([WINNER]);
    cron.setConfig({ analyzerAgentId: 'codex' });
    await cron.runNow('cron');
    const second = await cron.runNow('cron');
    expect(second).toMatchObject({ status: 'skipped', reason: 'no_new_data' });
    expect(engine.listProposals()).toHaveLength(1);
  });

  it('rejects approving an unavailable agent as the learning LLM', () => {
    const cron = cronWith([]);
    expect(() => cron.setConfig({ analyzerAgentId: 'nope' })).toThrow(/not available/);
  });

  it('clears the pinned model when the dropdown returns to Default / Auto', () => {
    const cron = cronWith([]);
    cron.setConfig({ analyzerAgentId: 'codex', analyzerModel: 'gpt-test' });
    expect(cron.getConfig().analyzerModel).toBe('gpt-test');
    cron.setConfig({ analyzerAgentId: 'codex', analyzerModel: '' });
    expect(cron.getConfig().analyzerModel).toBeUndefined();
  });

  it('purges old routing approvals: pending + approved routing rules are deleted and stop steering routing', async () => {
    seed();
    const cron = cronWith([WINNER]);
    cron.setConfig({ analyzerAgentId: 'codex', mode: 'auto' });
    const run = await cron.runNow('manual');
    expect(engine.getProposal(run.proposalIds[0]!)!.status).toBe('approved');
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(1);
    // A second, still-pending routing proposal and a non-routing proposal.
    const pending = engine.evaluate({
      comparabilityKey: 'capability:objective.fulfill', kind: 'routing_rule', summary: 'pending routing',
      payload: { capability: 'objective.fulfill', preferAdapterId: 'claude-code' },
    }, { sampleSize: 3, failureRate: 0, meanDurationMs: 1 });
    expect(pending.classification).toBe('demonstrated');
    const skill = engine.evaluate({
      comparabilityKey: 'capability:objective.fulfill', kind: 'skill', summary: 'keep me', payload: {},
    }, { sampleSize: 3, failureRate: 0, meanDurationMs: 1 });
    expect(skill.classification).toBe('demonstrated');

    const result = cron.purgeRoutingApprovals();
    expect(result.removed).toBe(2);
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(0.5);
    expect(engine.listProposals().filter((p) => p.kind === 'routing_rule')).toHaveLength(0);
    expect(engine.listProposals().filter((p) => p.kind === 'skill')).toHaveLength(1);
    expect(audit.list().some((e) => e.action === 'routing_approvals_purged')).toBe(true);
    // Purging again is a no-op.
    expect(cron.purgeRoutingApprovals().removed).toBe(0);
  });

  it('changing the approved LLM/model purges approvals made under the previous one', async () => {
    seed();
    const cron = cronWith([WINNER]);
    cron.setConfig({ analyzerAgentId: 'codex', mode: 'auto' });
    await cron.runNow('manual');
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(1);
    // Re-saving the same analyzer keeps approvals; switching model purges them.
    cron.setConfig({ mode: 'manual' });
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(1);
    cron.setConfig({ analyzerAgentId: 'codex', analyzerModel: 'gpt-other' });
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(0.5);
    expect(engine.listProposals().filter((p) => p.kind === 'routing_rule')).toHaveLength(0);
  });
});

describe('parseRoutingSuggestions', () => {
  it('only accepts known agents/keys from the fenced block', () => {
    const text = 'prose\n```conductor.routing\n[{"comparabilityKey":"capability:objective.fulfill","capability":"objective.fulfill","preferAdapterId":"codex","summary":"ok"},{"comparabilityKey":"capability:objective.fulfill","capability":"objective.fulfill","preferAdapterId":"ghost","summary":"bad"}]\n```';
    expect(parseRoutingSuggestions(text, ['codex'], ['capability:objective.fulfill'])).toHaveLength(1);
    expect(parseRoutingSuggestions('no block', ['codex'], ['capability:objective.fulfill'])).toEqual([]);
  });
});
