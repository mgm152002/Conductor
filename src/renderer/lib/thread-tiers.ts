import type { ThreadView } from './threads';
import { isWorkingState } from './thread-status';

// T3 Code-style thread management for a project: every thread sits in exactly
// one of four tiers. "Needs attention" is always first (and shown), the rest
// live behind collapsible lists in the sidebar.
//
//   needs-attention — something is waiting on the user: a question that needs
//     an answer, a pending approval, a thread that just completed / failed /
//     got blocked or interrupted, or a snoozed thread whose snooze has ended.
//   working         — an agent is still doing (or about to do) work.
//   settled         — the user marked it done ("Mark as settled"), or it was
//     cancelled. A settled thread leaves this tier on its own when new work
//     arrives, when a question/approval appears, or when it completes again.
//   snoozed         — the user deferred it until `snoozedUntil`. While snoozed
//     it stays out of the way (even if it finishes); a pending question or
//     approval still pulls it straight back to Needs attention. When the
//     snooze ends it "wakes up" into Needs attention until it is settled,
//     snoozed again, or opened.

export type ThreadTierId = 'needs-attention' | 'working' | 'settled' | 'snoozed';

export type ThreadAttentionReason =
  | 'question'
  | 'approval'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'interrupted'
  | 'snooze-woke';

export interface ThreadTierInfo {
  tier: ThreadTierId;
  /** Why the thread needs the user, when `tier` is `needs-attention`. */
  attentionReason?: ThreadAttentionReason;
  /** Short pill text for a Needs-attention thread, e.g. "Needs answer". */
  attentionLabel?: string;
}

/** A user's per-thread disposition, keyed by thread key in the tier store. */
export interface ThreadTierPref {
  mode: 'settled' | 'snoozed';
  /** `latest.updatedAt` of the thread when the user settled/snoozed it. New
   * activity after this point makes a settled disposition stale. */
  seenUpdatedAt: string;
  /** ISO-8601 wake time for a snooze. Absent means snoozed indefinitely. */
  snoozedUntil?: string;
}

export type ThreadTierPrefs = Record<string, ThreadTierPref>;

export interface ThreadTierSignals {
  hasPendingApproval: boolean;
  hasPendingQuestion: boolean;
}

export const NO_THREAD_SIGNALS: ThreadTierSignals = { hasPendingApproval: false, hasPendingQuestion: false };

export interface ThreadTierGroup {
  id: ThreadTierId;
  label: string;
  threads: ThreadView[];
}

export const THREAD_TIER_LABELS: Record<ThreadTierId, string> = {
  'needs-attention': 'Needs attention',
  working: 'Working',
  settled: 'Settled',
  snoozed: 'Snoozed',
};

const TIER_ORDER: ThreadTierId[] = ['needs-attention', 'working', 'settled', 'snoozed'];

const ATTENTION_LABELS: Record<ThreadAttentionReason, string> = {
  question: 'Needs answer',
  approval: 'Pending approval',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  interrupted: 'Interrupted',
  'snooze-woke': 'Snooze ended',
};

function attention(reason: ThreadAttentionReason): ThreadTierInfo {
  return { tier: 'needs-attention', attentionReason: reason, attentionLabel: ATTENTION_LABELS[reason] };
}

/** The default snooze: tomorrow at 09:00 local time. */
export function defaultSnoozeUntil(now: Date = new Date()): string {
  const until = new Date(now);
  until.setDate(until.getDate() + 1);
  until.setHours(9, 0, 0, 0);
  return until.toISOString();
}

export function isSnoozeExpired(pref: ThreadTierPref | undefined, now: number = Date.now()): boolean {
  if (pref?.mode !== 'snoozed' || pref.snoozedUntil === undefined) return false;
  const until = Date.parse(pref.snoozedUntil);
  return !Number.isNaN(until) && until <= now;
}

export function classifyThreadTier(
  thread: ThreadView,
  pref: ThreadTierPref | undefined,
  signals: ThreadTierSignals = NO_THREAD_SIGNALS,
  now: number = Date.now(),
): ThreadTierInfo {
  // A question or approval is waiting on the user right now — nothing,
  // not even a snooze, hides that.
  if (signals.hasPendingQuestion) return attention('question');
  if (signals.hasPendingApproval || thread.latest.state === 'WAITING_FOR_APPROVAL') return attention('approval');

  if (pref?.mode === 'snoozed') {
    // Waking up is itself an attention event: it stays in Needs attention
    // until the user settles it, snoozes it again, or opens it (which
    // acknowledges the wake). An indefinite snooze never wakes on its own.
    if (isSnoozeExpired(pref, now)) return attention('snooze-woke');
    return { tier: 'snoozed' };
  }

  if (pref?.mode === 'settled' && pref.seenUpdatedAt === thread.latest.updatedAt) {
    return { tier: 'settled' };
  }

  if (isWorkingState(thread.latest.state)) return { tier: 'working' };

  switch (thread.latest.state) {
    case 'COMPLETED': return attention('completed');
    case 'FAILED': return attention('failed');
    case 'BLOCKED': return attention('blocked');
    case 'RECOVERABLE_INTERRUPTION': return attention('interrupted');
    default: return { tier: 'settled' }; // CANCELLED and anything idle
  }
}

/**
 * Bucket threads into the four tiers, in display order (Needs attention
 * first). Threads keep their incoming (most-recently-updated first) order
 * inside each tier. Empty tiers are omitted.
 */
export function groupThreadsByTier(
  threads: readonly ThreadView[],
  prefs: ThreadTierPrefs,
  signalsFor: (thread: ThreadView) => ThreadTierSignals = () => NO_THREAD_SIGNALS,
  now: number = Date.now(),
): ThreadTierGroup[] {
  const buckets = new Map<ThreadTierId, ThreadView[]>(TIER_ORDER.map((id) => [id, []]));
  for (const thread of threads) {
    const { tier } = classifyThreadTier(thread, prefs[thread.key], signalsFor(thread), now);
    buckets.get(tier)!.push(thread);
  }
  return TIER_ORDER
    .map((id) => ({ id, label: THREAD_TIER_LABELS[id], threads: buckets.get(id)! }))
    .filter((group) => group.threads.length > 0);
}
