import { create } from 'zustand';

// Presentation-only state for the chat shell: whether the main view shows a
// fresh draft (new thread) instead of the focused task, the right-hand details
// panel, and which sidebar project groups are collapsed. Nothing here is
// durable domain state.

export type DetailsTab = 'plan' | 'checks' | 'files' | 'context' | 'activity';

interface UiState {
  /** True while composing a new thread; the chat view shows the draft hero. */
  draft: boolean;
  detailsOpen: boolean;
  detailsTab: DetailsTab;
  collapsedProjects: Record<string, boolean>;
  addProjectOpen: boolean;
  /** Composer plan mode: a planner agent splits the message across agents. */
  planMode: boolean;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  setDraft: (draft: boolean) => void;
  setDetailsOpen: (open: boolean) => void;
  openDetails: (tab: DetailsTab) => void;
  toggleProject: (id: string) => void;
  setAddProjectOpen: (open: boolean) => void;
  setPlanMode: (on: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  draft: false,
  detailsOpen: true,
  detailsTab: 'files',
  collapsedProjects: {},
  addProjectOpen: false,
  planMode: false,
  notice: null,
  setNotice: (notice): void => { set({ notice }); },
  setDraft: (draft): void => { set({ draft }); },
  setDetailsOpen: (detailsOpen): void => { set({ detailsOpen }); },
  openDetails: (detailsTab): void => { set({ detailsOpen: true, detailsTab }); },
  toggleProject: (id): void => {
    set((state) => ({ collapsedProjects: { ...state.collapsedProjects, [id]: !state.collapsedProjects[id] } }));
  },
  setAddProjectOpen: (addProjectOpen): void => { set({ addProjectOpen }); },
  setPlanMode: (planMode): void => { set({ planMode }); },
}));
