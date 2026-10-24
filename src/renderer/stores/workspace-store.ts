import { create } from 'zustand';
import type { Workspace } from '@shared/domain';

// Renderer-side mirror of workspace state. The durable source of truth lives
// in the main process; this store holds the list the UI renders and the
// currently-selected workspace, kept in sync through the `window.conductor`
// bridge. Later tasks (5.2) wire the create/list/select screens to these
// actions.

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  loading: boolean;
  error: string | null;
  setWorkspaces: (workspaces: Workspace[]) => void;
  upsert: (workspace: Workspace) => void;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  loading: false,
  error: null,
  setWorkspaces: (workspaces): void => {
    set({ workspaces });
  },
  upsert: (workspace): void => {
    set((state) => {
      const index = state.workspaces.findIndex((w) => w.id === workspace.id);
      if (index === -1) {
        return { workspaces: [...state.workspaces, workspace] };
      }
      const next = state.workspaces.slice();
      next[index] = workspace;
      return { workspaces: next };
    });
  },
  remove: (id): void => {
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
      activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
    }));
  },
  setActive: (id): void => {
    set({ activeWorkspaceId: id });
  },
  setLoading: (loading): void => {
    set({ loading });
  },
  setError: (error): void => {
    set({ error });
  },
}));
