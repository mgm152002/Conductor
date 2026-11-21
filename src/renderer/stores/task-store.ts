import { create } from 'zustand';
import type { Task } from '@shared/domain';

// Renderer-side mirror of active tasks. Tasks are keyed by id so the
// `task.updated` main -> renderer event can upsert in place without reordering.
// The orchestrator owns the durable task lifecycle; this store only reflects it.

interface TaskState {
  tasks: Record<string, Task>;
  focusedTaskId: string | null;
  detailsRevision: Record<string, number>;
  focus: (id: string | null) => void;
  bumpDetails: (id: string) => void;
  setTasks: (tasks: Task[]) => void;
  upsert: (task: Task) => void;
  remove: (id: string) => void;
  /** Drop every task of a deleted project. */
  removeWorkspace: (workspaceId: string) => void;
  /** Drop every task (message) in a deleted thread. */
  removeThread: (threadId: string) => void;
  clear: () => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: {},
  focusedTaskId: null,
  detailsRevision: {},
  focus: (id): void => { set({ focusedTaskId: id }); },
  bumpDetails: (id): void => {
    set((state) => ({ detailsRevision: { ...state.detailsRevision, [id]: (state.detailsRevision[id] ?? 0) + 1 } }));
  },
  setTasks: (tasks): void => {
    // Lists may be workspace-scoped and race live events. Merge snapshots
    // without losing other workspaces or rolling a running task back to CREATED.
    // A refresh that brings nothing new keeps the same map, so the views
    // subscribed to it (sidebar, thread, agents) don't re-render on every poll.
    set((state) => {
      let next: Record<string, Task> | null = null;
      for (const task of tasks) {
        const previous = (next ?? state.tasks)[task.id];
        const chosen = keepIfSame(previous, newestTask(previous, task, true));
        if (chosen === previous) continue;
        next ??= { ...state.tasks };
        next[task.id] = chosen;
      }
      return next === null ? state : { tasks: next };
    });
  },
  upsert: (task): void => {
    set((state) => {
      const previous = state.tasks[task.id];
      const chosen = keepIfSame(previous, newestTask(previous, task));
      return chosen === previous ? state : { tasks: { ...state.tasks, [task.id]: chosen } };
    });
  },
  remove: (id): void => {
    set((state) => {
      if (!(id in state.tasks)) {
        return state;
      }
      const next = { ...state.tasks };
      delete next[id];
      return { tasks: next, focusedTaskId: state.focusedTaskId === id ? null : state.focusedTaskId };
    });
  },
  removeWorkspace: (workspaceId): void => {
    set((state) => {
      const next = Object.fromEntries(Object.entries(state.tasks).filter(([, task]) => task.workspaceId !== workspaceId));
      const focusedGone = state.focusedTaskId !== null && !(state.focusedTaskId in next);
      return { tasks: next, focusedTaskId: focusedGone ? null : state.focusedTaskId };
    });
  },
  removeThread: (threadId): void => {
    set((state) => {
      const next = Object.fromEntries(Object.entries(state.tasks).filter(([, task]) => (task.threadId ?? task.id) !== threadId));
      if (Object.keys(next).length === Object.keys(state.tasks).length) return state;
      const detailsRevision = { ...state.detailsRevision };
      for (const id of Object.keys(state.tasks)) if (!(id in next)) delete detailsRevision[id];
      const focusedGone = state.focusedTaskId !== null && !(state.focusedTaskId in next);
      return { tasks: next, detailsRevision, focusedTaskId: focusedGone ? null : state.focusedTaskId };
    });
  },
  clear: (): void => {
    set({ tasks: {}, focusedTaskId: null, detailsRevision: {} });
  },
}));

/** The stored task when the chosen one says the same thing, so unchanged data keeps its identity. */
function keepIfSame(previous: Task | undefined, chosen: Task): Task {
  if (previous === undefined || previous === chosen) return chosen;
  return previous.updatedAt === chosen.updatedAt && previous.state === chosen.state && JSON.stringify(previous) === JSON.stringify(chosen) ? previous : chosen;
}

function newestTask(previous: Task | undefined, incoming: Task, snapshot = false): Task {
  if (previous === undefined) return incoming;
  const order = incoming.updatedAt.localeCompare(previous.updatedAt);
  // Multiple transitions may share a millisecond. There is no linear ranking
  // for recovery or approval states, but CREATED cannot follow execution.
  if (order < 0 || (order === 0 && (
    (snapshot && previous.state !== 'CREATED') ||
    (incoming.state === 'CREATED' && previous.state !== 'CREATED') ||
    (isTerminalTask(previous) && !isTerminalTask(incoming))
  ))) return previous;
  return incoming;
}

export function isTerminalTask(task: Task): boolean {
  return task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELLED';
}

export function tasksForWorkspace(tasks: Record<string, Task>, workspaceId: string | null): Task[] {
  if (workspaceId === null) return [];
  return Object.values(tasks).filter((task) => task.workspaceId === workspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

/** Active (non-terminal) tasks in a stable, creation-ordered array. */
export function selectActiveTasks(state: TaskState): Task[] {
  return Object.values(state.tasks)
    .filter((task) => !isTerminalTask(task))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
