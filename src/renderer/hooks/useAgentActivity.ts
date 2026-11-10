import { useMemo } from 'react';
import type { Task } from '@shared/domain';
import { useApprovalStore, useQuestionStore, useTaskStore } from '../stores';
import { useSandboxAgentStore } from '../stores/sandbox-agent-store';
import { useTaskDetails } from './useTaskDetails';
import { buildTimeline, latestActivity } from '../lib/timeline';
import { isWorkingState, threadTitle } from '../lib/thread-status';
import { threadKey } from '../lib/threads';
import type { AgentMood } from '../components/ui/AgentAvatar';

// What a sandbox agent is doing right now, for its character: a mood and a
// one-line speech bubble. Read from the agent's threads — the most recently
// active one decides — plus pending approvals and questions.

const RECENT_MS = 10 * 60_000;

export interface AgentActivity {
  mood: AgentMood;
  /** Speech bubble text; absent at rest. */
  say?: string;
  /** The thread the mood comes from, to open it. */
  task?: Task;
  /** How many of its threads are working right now. */
  working: number;
}

export function useAgentActivity(agentId: string): AgentActivity {
  const threads = useSandboxAgentStore((s) => s.threads);
  const tasks = useTaskStore((s) => s.tasks);
  const approvals = useApprovalStore((s) => s.pending);
  const questions = useQuestionStore((s) => s.pending);

  const base = useMemo(() => {
    const mine = new Set(Object.entries(threads).filter(([, id]) => id === agentId).map(([threadId]) => threadId));
    const own = Object.values(tasks).filter((task) => mine.has(threadKey(task)));
    const latest = [...own].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const ids = new Set(own.map((task) => task.id));
    const waitingOn = approvals.find((request) => ids.has(request.taskId)) ?? questions.find((request) => ids.has(request.taskId));
    const working = own.filter((task) => isWorkingState(task.state)).length;
    return { latest, waiting: waitingOn !== undefined, working };
  }, [threads, tasks, approvals, questions, agentId]);

  const live = base.latest !== undefined && isWorkingState(base.latest.state) ? base.latest : null;
  // Only the live task's details are loaded, for its current step.
  const { details } = useTaskDetails(live);
  const current = useMemo(() => (live !== null && details !== null ? latestActivity(buildTimeline(live, details)) : undefined), [live, details]);

  const { latest, waiting, working } = base;
  if (latest === undefined) return { mood: 'idle', working };
  const recent = Date.now() - Date.parse(latest.updatedAt) < RECENT_MS;
  if (waiting || latest.state === 'WAITING_FOR_APPROVAL') return { mood: 'waiting', say: 'Waiting for your approval', task: latest, working };
  if (isWorkingState(latest.state)) {
    const label = current?.label ?? (latest.state === 'VERIFYING' ? 'Checking my work' : 'Working on it');
    return { mood: 'working', say: `${label.length > 64 ? `${label.slice(0, 63)}…` : label}`, task: latest, working };
  }
  if (recent && latest.state === 'COMPLETED') return { mood: 'done', say: `Done: ${threadTitle(latest).slice(0, 48)}`, task: latest, working };
  if (recent && (latest.state === 'FAILED' || latest.state === 'BLOCKED' || latest.state === 'RECOVERABLE_INTERRUPTION')) {
    return { mood: 'error', say: latest.state === 'FAILED' ? 'That didn’t work' : 'I’m stuck, can you take a look?', task: latest, working };
  }
  return { mood: 'idle', task: latest, working };
}
