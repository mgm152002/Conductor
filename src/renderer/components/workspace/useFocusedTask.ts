import type { Task } from '@shared/domain';
import { useTaskStore, useWorkspaceStore } from '../../stores';

/** Explicit selection wins within a workspace; otherwise show its newest task. */
export function pickFocusedTask(tasks: Record<string, Task>, focusedTaskId?: string | null, workspaceId?: string | null): Task | null {
  const values = Object.values(tasks).filter((task) => workspaceId === undefined || task.workspaceId === workspaceId);
  const focused = focusedTaskId == null ? undefined : tasks[focusedTaskId];
  if (focused !== undefined && (workspaceId === undefined || focused.workspaceId === workspaceId)) return focused;
  if (values.length === 0) {
    return null;
  }
  return values.reduce((latest, task) =>
    task.createdAt.localeCompare(latest.createdAt) >= 0 ? task : latest,
  );
}

export function useFocusedTask(): Task | null {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  return useTaskStore((state) => pickFocusedTask(state.tasks, state.focusedTaskId, workspaceId));
}
