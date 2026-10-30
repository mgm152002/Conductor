import { beforeEach, describe, expect, it } from 'vitest';
import type { Task, TaskState } from '../../src/shared/domain';
import {
  classifyThreadTier, defaultSnoozeUntil, groupThreadsByTier, NO_THREAD_SIGNALS,
  type ThreadTierPref,
} from '../../src/renderer/lib/thread-tiers';
import type { ThreadView } from '../../src/renderer/lib/threads';
import { useThreadTierStore } from '../../src/renderer/stores/thread-tier-store';

function task(state: TaskState, updatedAt = '2026-10-26T10:00:00.000Z'): Task {
  return {
    id: 'task-1', workspaceId: 'project-1', objective: 'Do the thing', acceptanceCriteria: [],
    state, contextRefs: [], createdAt: '2026-10-26T09:00:00.000Z', updatedAt,
  };
}

function thread(state: TaskState, updatedAt?: string): ThreadView {
  const latest = task(state, updatedAt);
  return { key: latest.id, root: latest, latest, tasks: [latest] };
}

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const settled = (seenUpdatedAt: string): ThreadTierPref => ({ mode: 'settled', seenUpdatedAt });
const snoozed = (snoozedUntil?: string): ThreadTierPref => ({
  mode: 'snoozed', seenUpdatedAt: '2026-10-26T10:00:00.000Z', ...(snoozedUntil ? { snoozedUntil } : {}),
});

describe('classifyThreadTier', () => {
  it('puts working states in Working', () => {
    for (const state of ['CREATED', 'PLANNING', 'RUNNING', 'VERIFYING'] as TaskState[]) {
      expect(classifyThreadTier(thread(state), undefined, NO_THREAD_SIGNALS, NOW).tier).toBe('working');
    }
  });

  it('puts a completed thread in Needs attention until it is marked settled', () => {
    const done = thread('COMPLETED');
    expect(classifyThreadTier(done, undefined, NO_THREAD_SIGNALS, NOW))
      .toEqual({ tier: 'needs-attention', attentionReason: 'completed', attentionLabel: 'Completed' });
    expect(classifyThreadTier(done, settled(done.latest.updatedAt), NO_THREAD_SIGNALS, NOW).tier).toBe('settled');
  });

  it('puts failed, blocked, interrupted and approval-waiting threads in Needs attention', () => {
    expect(classifyThreadTier(thread('FAILED'), undefined, NO_THREAD_SIGNALS, NOW).attentionReason).toBe('failed');
    expect(classifyThreadTier(thread('BLOCKED'), undefined, NO_THREAD_SIGNALS, NOW).attentionReason).toBe('blocked');
    expect(classifyThreadTier(thread('RECOVERABLE_INTERRUPTION'), undefined, NO_THREAD_SIGNALS, NOW).attentionReason).toBe('interrupted');
    expect(classifyThreadTier(thread('WAITING_FOR_APPROVAL'), undefined, NO_THREAD_SIGNALS, NOW).attentionReason).toBe('approval');
    expect(classifyThreadTier(thread('RUNNING'), undefined, { hasPendingApproval: true, hasPendingQuestion: false }, NOW).attentionReason).toBe('approval');
  });

  it('puts a thread with a question requiring an answer first, even over a snooze', () => {
    const info = classifyThreadTier(thread('RUNNING'), snoozed('2026-10-27T09:00:00.000Z'), { hasPendingApproval: false, hasPendingQuestion: true }, NOW);
    expect(info).toEqual({ tier: 'needs-attention', attentionReason: 'question', attentionLabel: 'Needs answer' });
  });

  it('settles a cancelled thread without any user action', () => {
    expect(classifyThreadTier(thread('CANCELLED'), undefined, NO_THREAD_SIGNALS, NOW).tier).toBe('settled');
  });

  it('keeps a snoozed thread snoozed while its snooze is still running', () => {
    expect(classifyThreadTier(thread('COMPLETED'), snoozed('2026-10-27T09:00:00.000Z'), NO_THREAD_SIGNALS, NOW).tier).toBe('snoozed');
    expect(classifyThreadTier(thread('RUNNING'), snoozed(), NO_THREAD_SIGNALS, NOW).tier).toBe('snoozed');
  });

  it('wakes a snoozed thread into Needs attention when its snooze ends', () => {
    const info = classifyThreadTier(thread('RUNNING'), snoozed('2026-10-26T11:00:00.000Z'), NO_THREAD_SIGNALS, NOW);
    expect(info).toEqual({ tier: 'needs-attention', attentionReason: 'snooze-woke', attentionLabel: 'Snooze ended' });
  });

  it('lets new activity supersede a stale settled mark', () => {
    const done = thread('COMPLETED', '2026-10-26T11:00:00.000Z');
    // Settled against an older update, then the thread moved on.
    expect(classifyThreadTier(done, settled('2026-10-26T10:00:00.000Z'), NO_THREAD_SIGNALS, NOW).tier).toBe('needs-attention');
    const running = thread('RUNNING', '2026-10-26T11:00:00.000Z');
    expect(classifyThreadTier(running, settled('2026-10-26T10:00:00.000Z'), NO_THREAD_SIGNALS, NOW).tier).toBe('working');
  });

  it('snoozes until tomorrow morning by default', () => {
    const until = new Date(defaultSnoozeUntil(new Date('2026-10-26T15:30:00')));
    expect(until.getDate()).toBe(27);
    expect(until.getHours()).toBe(9);
    expect(until.getMinutes()).toBe(0);
  });
});

describe('groupThreadsByTier', () => {
  it('orders Needs attention first, then Working, Settled and Snoozed', () => {
    const done = thread('COMPLETED', '2026-10-26T08:00:00.000Z');
    const working = { ...thread('RUNNING'), key: 'working', root: { ...task('RUNNING'), id: 'working' } };
    working.latest = working.root; working.tasks = [working.root];
    const cancelled = { ...thread('CANCELLED'), key: 'cancelled', root: { ...task('CANCELLED'), id: 'cancelled' } };
    cancelled.latest = cancelled.root; cancelled.tasks = [cancelled.root];
    const deferred = { ...thread('COMPLETED'), key: 'deferred', root: { ...task('COMPLETED'), id: 'deferred' } };
    deferred.latest = deferred.root; deferred.tasks = [deferred.root];

    const groups = groupThreadsByTier(
      [working, cancelled, deferred, done],
      { deferred: snoozed('2026-10-27T09:00:00.000Z') },
      () => NO_THREAD_SIGNALS,
      NOW,
    );

    expect(groups.map((group) => group.id)).toEqual(['needs-attention', 'working', 'settled', 'snoozed']);
    expect(groups[0]?.threads.map((item) => item.key)).toEqual(['task-1']);
    expect(groups[0]?.label).toBe('Needs attention');
  });

  it('omits empty tiers', () => {
    expect(groupThreadsByTier([thread('RUNNING')], {}, () => NO_THREAD_SIGNALS, NOW).map((group) => group.id)).toEqual(['working']);
    expect(groupThreadsByTier([], {}, () => NO_THREAD_SIGNALS, NOW)).toEqual([]);
  });
});

describe('useThreadTierStore', () => {
  beforeEach(() => { useThreadTierStore.getState().reset(); });

  it('marks settled, snoozes and clears a thread disposition', () => {
    const store = useThreadTierStore.getState();
    store.markSettled('thread-1', '2026-10-26T10:00:00.000Z');
    expect(useThreadTierStore.getState().prefs['thread-1']).toEqual({ mode: 'settled', seenUpdatedAt: '2026-10-26T10:00:00.000Z' });

    store.snooze('thread-1', '2026-10-26T10:00:00.000Z', '2026-10-27T09:00:00.000Z');
    expect(useThreadTierStore.getState().prefs['thread-1']?.mode).toBe('snoozed');
    expect(useThreadTierStore.getState().prefs['thread-1']?.snoozedUntil).toBe('2026-10-27T09:00:00.000Z');

    store.clear('thread-1');
    expect(useThreadTierStore.getState().prefs['thread-1']).toBeUndefined();
  });
});
