import type { Task, TaskState } from '@shared/domain';

// Maps a task (shown as a "thread") to the compact status pill used in the
// sidebar and chat header, in the style of T3 Code's thread status pills.

export interface ThreadStatus {
  label: string;
  /** Text colour class. */
  colorClass: string;
  /** Dot background class. */
  dotClass: string;
  pulse: boolean;
  /** Whether the task is still doing (or waiting to do) work. */
  active: boolean;
}

const WORKING: ReadonlySet<TaskState> = new Set(['CREATED', 'CONTEXT_LOADING', 'PLANNING', 'RUNNING', 'VERIFYING']);

export function threadStatus(task: Task, hasPendingApproval: boolean): ThreadStatus {
  if (hasPendingApproval || task.state === 'WAITING_FOR_APPROVAL') {
    return { label: 'Pending approval', colorClass: 'text-amber-600 dark:text-amber-300/90', dotClass: 'bg-amber-500 dark:bg-amber-300/90', pulse: false, active: true };
  }
  if (WORKING.has(task.state)) {
    const label = task.state === 'VERIFYING' ? 'Verifying' : task.state === 'PLANNING' || task.state === 'CONTEXT_LOADING' || task.state === 'CREATED' ? 'Starting' : 'Working';
    return { label, colorClass: 'text-sky-600 dark:text-sky-300/80', dotClass: 'bg-sky-500 dark:bg-sky-300/80', pulse: true, active: true };
  }
  switch (task.state) {
    case 'COMPLETED':
      return { label: 'Completed', colorClass: 'text-emerald-600 dark:text-emerald-300/90', dotClass: 'bg-emerald-500 dark:bg-emerald-300/90', pulse: false, active: false };
    case 'FAILED':
      return { label: 'Failed', colorClass: 'text-red-600 dark:text-red-300/90', dotClass: 'bg-red-500 dark:bg-red-300/90', pulse: false, active: false };
    case 'BLOCKED':
      return { label: 'Blocked', colorClass: 'text-orange-600 dark:text-orange-300/90', dotClass: 'bg-orange-500 dark:bg-orange-300/90', pulse: false, active: true };
    case 'RECOVERABLE_INTERRUPTION':
      return { label: 'Interrupted', colorClass: 'text-violet-600 dark:text-violet-300/90', dotClass: 'bg-violet-500 dark:bg-violet-300/90', pulse: false, active: true };
    case 'CANCELLED':
      return { label: 'Stopped', colorClass: 'text-muted-foreground', dotClass: 'bg-muted-foreground/60', pulse: false, active: false };
    default:
      return { label: task.state.toLowerCase().replace(/_/g, ' '), colorClass: 'text-muted-foreground', dotClass: 'bg-muted-foreground/60', pulse: false, active: false };
  }
}

/** First line of the objective, used as the thread title. */
export function threadTitle(task: Pick<Task, 'objective'>): string {
  const first = task.objective.split('\n').find((line) => line.trim() !== '')?.trim() ?? 'Untitled task';
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

export function isWorkingState(state: TaskState): boolean {
  return WORKING.has(state);
}
