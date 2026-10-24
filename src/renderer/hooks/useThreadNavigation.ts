import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@shared/domain';
import { useTaskStore, useUiStore, useWorkspaceStore } from '../stores';

/**
 * Navigation between threads (tasks) and projects (workspaces). Opening a
 * thread in another project selects that project first, because task lists,
 * focus and context are all scoped to the active workspace.
 */
export function useThreadNavigation(): {
  openThread: (task: Pick<Task, 'id' | 'workspaceId'>) => Promise<void>;
  newThread: (workspaceId?: string) => Promise<void>;
  selectProject: (workspaceId: string) => Promise<void>;
} {
  const navigate = useNavigate();

  const selectProject = useCallback(async (workspaceId: string): Promise<void> => {
    if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) return;
    await window.conductor.workspace.select(workspaceId);
    useWorkspaceStore.getState().setActive(workspaceId);
  }, []);

  const openThread = useCallback(async (task: Pick<Task, 'id' | 'workspaceId'>): Promise<void> => {
    await selectProject(task.workspaceId);
    useTaskStore.getState().focus(task.id);
    useUiStore.getState().setDraft(false);
    navigate('/work');
  }, [navigate, selectProject]);

  const newThread = useCallback(async (workspaceId?: string): Promise<void> => {
    if (workspaceId !== undefined) await selectProject(workspaceId);
    useTaskStore.getState().focus(null);
    useUiStore.getState().setDraft(true);
    navigate('/work');
  }, [navigate, selectProject]);

  return { openThread, newThread, selectProject };
}
