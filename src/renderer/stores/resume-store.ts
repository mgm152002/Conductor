import { create } from 'zustand';
import type { ResumeSnapshot } from '@shared/domain';

// Renderer-side holder for the Resume Center snapshot. On boot the main process
// reconciles non-terminal tasks and produces a snapshot; the renderer requests
// it via `window.conductor.resume.snapshot` and the main process may also push
// a refreshed snapshot over the `resume.snapshot` event. The full Resume Center
// UI lands in task 11.2; this store establishes the state contract now.

interface ResumeState {
  snapshot: ResumeSnapshot | null;
  loading: boolean;
  error: string | null;
  setSnapshot: (snapshot: ResumeSnapshot) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useResumeStore = create<ResumeState>((set) => ({
  snapshot: null,
  loading: false,
  error: null,
  setSnapshot: (snapshot): void => {
    set({ snapshot });
  },
  setLoading: (loading): void => {
    set({ loading });
  },
  setError: (error): void => {
    set({ error });
  },
}));
