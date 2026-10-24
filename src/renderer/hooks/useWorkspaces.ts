import { useCallback, useEffect } from 'react';
import type { Workspace } from '@shared/domain';
import { useWorkspaceStore } from '../stores';

// Wires the workspace store to the `window.conductor` bridge: loads the list on
// mount and exposes create/select actions that round-trip through the main
// process (the durable source of truth) and reflect the result back into the
// store. The main process persists the active workspace across restarts, so the
// store is only a mirror of what it reports.

interface UseWorkspacesResult {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: { name: string; rootPath: string }) => Promise<void>;
  select: (id: string) => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export function useWorkspaces(): UseWorkspacesResult {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loading = useWorkspaceStore((s) => s.loading);
  const error = useWorkspaceStore((s) => s.error);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const upsert = useWorkspaceStore((s) => s.upsert);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const setLoading = useWorkspaceStore((s) => s.setLoading);
  const setError = useWorkspaceStore((s) => s.setError);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.conductor.workspace.list();
      setWorkspaces(list);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [setWorkspaces, setLoading, setError]);

  const create = useCallback(
    async (input: { name: string; rootPath: string }): Promise<void> => {
      setError(null);
      try {
        const created = await window.conductor.workspace.create(input);
        upsert(created);
      } catch (err) {
        setError(messageOf(err));
        throw err;
      }
    },
    [upsert, setError],
  );

  const select = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      try {
        await window.conductor.workspace.select(id);
        setActive(id);
      } catch (err) {
        setError(messageOf(err));
        throw err;
      }
    },
    [setActive, setError],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    workspaces,
    activeWorkspaceId,
    loading,
    error,
    refresh,
    create,
    select,
  };
}
