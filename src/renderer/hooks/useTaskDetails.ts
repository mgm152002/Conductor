import { useCallback, useEffect, useState } from 'react';
import type { Task } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { useTaskStore } from '../stores/task-store';

export function useTaskDetails(task: Task | null): {
  details: TaskDetails | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const revision = useTaskStore((state) => task === null ? 0 : state.detailsRevision[task.id] ?? 0);
  const refresh = useCallback(() => { setRefreshVersion((value) => value + 1); }, []);
  const id = task?.id;
  const updatedAt = task?.updatedAt;
  const state = task?.state;

  useEffect(() => {
    let active = true;
    if (id === undefined) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void window.conductor.task.details(id).then((details) => {
      if (active) {
        setSnapshot(details);
        useTaskStore.getState().setTasks([details.task]);
      }
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Could not load task details');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, updatedAt, state, revision, refreshVersion]);

  return { details: snapshot?.task.id === id ? snapshot : null, loading, error, refresh };
}
