import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceChanges } from '@shared/task-view';

// Loads the workspace's uncommitted files for the Files panel. Task transitions
// (`refreshKey`) trigger a foreground refresh; while the task is live a quiet
// poll keeps the list current without flashing a loading state. Paths and
// diffs are produced and bounded in the main process.
export function useWorkspaceChanges(
  workspaceId: string | null,
  refreshKey: string,
  live: boolean,
  taskId?: string | null,
): {
  changes: WorkspaceChanges | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (quiet: boolean): Promise<void> => {
    if (workspaceId === null) {
      request.current += 1;
      setChanges(null);
      setLoading(false);
      setError(null);
      return;
    }
    const sequence = ++request.current;
    if (!quiet) setLoading(true);
    try {
      const next = await window.conductor.workspace.changes(workspaceId, taskId ?? undefined);
      if (sequence !== request.current) return;
      setChanges(next);
      setError(null);
    } catch (err) {
      if (sequence !== request.current) return;
      setError(err instanceof Error ? err.message : 'Could not read changed files');
    } finally {
      if (sequence === request.current && !quiet) setLoading(false);
    }
  }, [workspaceId, taskId]);

  useEffect(() => {
    void load(false);
  }, [load, refreshKey]);

  useEffect(() => {
    if (!live || workspaceId === null) return;
    const timer = window.setInterval(() => { void load(true); }, 5_000);
    return () => { window.clearInterval(timer); };
  }, [live, workspaceId, load]);

  useEffect(() => () => { request.current += 1; }, []);

  return {
    changes,
    loading,
    error,
    refresh: () => { void load(false); },
  };
}
