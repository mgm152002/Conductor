import { useCallback, useEffect } from 'react';
import type {
  ResumeAction,
  ResumeActResult,
  ResumeSnapshot,
} from '@shared/domain';
import { useResumeStore, useTaskStore } from '../stores';

// Wires the Resume Center UI to the `window.conductor.resume` bridge. On mount
// it loads the boot reconciliation snapshot and subscribes to the
// `resume.snapshot` event so a main-process refresh pushes a new snapshot into
// the store. It exposes an `act` that round-trips a per-task action
// (resume/inspect/restart/discard) through the main process, returning the
// typed result so the caller can drive the confirmation flow (Requirement 8.7,
// 8.8): when the result is `confirmation_required`, the UI shows a confirm step
// and re-issues the action with `confirmed: true`.

interface UseResumeCenterResult {
  snapshot: ResumeSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  act: (input: {
    taskId: string;
    action: ResumeAction;
    confirmed?: boolean;
  }) => Promise<ResumeActResult>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export function useResumeCenter(): UseResumeCenterResult {
  const snapshot = useResumeStore((s) => s.snapshot);
  const loading = useResumeStore((s) => s.loading);
  const error = useResumeStore((s) => s.error);
  const setSnapshot = useResumeStore((s) => s.setSnapshot);
  const setLoading = useResumeStore((s) => s.setLoading);
  const setError = useResumeStore((s) => s.setError);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.conductor.resume.snapshot();
      setSnapshot(next);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [setSnapshot, setLoading, setError]);

  const act = useCallback(
    async (input: {
      taskId: string;
      action: ResumeAction;
      confirmed?: boolean;
    }): Promise<ResumeActResult> => {
      setError(null);
      try {
        const result = await window.conductor.resume.act(input);
        // A resume/restart/discard that was applied may have changed the task's
        // reconciled state; refresh the snapshot so the UI reflects it. A
        // confirmation_required result changed nothing, so leave the snapshot.
        if (result.status === 'applied') {
          const task = await window.conductor.task.get(input.taskId);
          useTaskStore.getState().upsert(task);
          useTaskStore.getState().bumpDetails(task.id);
          await refresh();
        }
        return result;
      } catch (err) {
        setError(messageOf(err));
        throw err;
      }
    },
    [refresh, setError],
  );

  useEffect(() => {
    void refresh();
    // The main process may push a refreshed snapshot (e.g. after a re-reconcile)
    // over the `resume.snapshot` event channel.
    const unsubscribe = window.conductor.on('resume.snapshot', (payload) => {
      setSnapshot(payload as ResumeSnapshot);
    });
    return unsubscribe;
  }, [refresh, setSnapshot]);

  return { snapshot, loading, error, refresh, act };
}
