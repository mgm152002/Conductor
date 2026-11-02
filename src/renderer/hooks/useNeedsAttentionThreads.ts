import { useMemo } from 'react';
import { useApprovalStore, useQuestionStore, useTaskStore, useThreadTierStore } from '../stores';
import { classifyThreadTier, groupThreadsByTier, type ThreadTierInfo } from '../lib/thread-tiers';
import { groupThreads, type ThreadView } from '../lib/threads';

export interface AttentionThread { thread: ThreadView; info: ThreadTierInfo }

/** Every thread, across all projects, that is waiting on the user right now. */
export function useNeedsAttentionThreads(): AttentionThread[] {
  const tasks = useTaskStore((s) => s.tasks);
  const approvals = useApprovalStore((s) => s.pending);
  const questions = useQuestionStore((s) => s.pending);
  const prefs = useThreadTierStore((s) => s.prefs);
  return useMemo(() => {
    const approvalIds = new Set(approvals.map((a) => a.taskId));
    const questionIds = new Set(questions.map((q) => q.taskId));
    const threads = groupThreads(Object.values(tasks)).sort((a, b) => b.latest.updatedAt.localeCompare(a.latest.updatedAt));
    const signalsFor = (thread: ThreadView) => ({
      hasPendingApproval: thread.tasks.some((t) => approvalIds.has(t.id)),
      hasPendingQuestion: thread.tasks.some((t) => questionIds.has(t.id)),
    });
    const now = Date.now();
    const group = groupThreadsByTier(threads, prefs, signalsFor, now).find((g) => g.id === 'needs-attention');
    return (group?.threads ?? []).map((thread) => ({ thread, info: classifyThreadTier(thread, prefs[thread.key], signalsFor(thread), now) }));
  }, [tasks, approvals, questions, prefs]);
}
