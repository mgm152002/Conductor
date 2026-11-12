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
  /** Sidebar Spaces whose thread list is collapsed (default: expanded). */
  collapsedSpaces: Record<string, boolean>;
  toggleSpace: (id: string) => void;
  addProjectOpen: boolean;
  /** First-run setup walkthrough. */
  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;
  /** Composer plan mode: a planner agent splits the message across agents. */
  planMode: boolean;
  /** The thread drawer at the left of Work and Chat is hidden. */
  panelCollapsed: boolean;
  setPanelCollapsed: (collapsed: boolean) => void;
  /** The ⌘K command palette. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  setDraft: (draft: boolean) => void;
  setDetailsOpen: (open: boolean) => void;
  openDetails: (tab: DetailsTab) => void;
  toggleProject: (id: string) => void;
  setAddProjectOpen: (open: boolean) => void;
  setPlanMode: (on: boolean) => void;
}

const PANEL_KEY = 'conductor.drawer.hidden';

function loadPanelCollapsed(): boolean {
  // The boards are the default way in; the drawer is opt-in.
  try { return window.localStorage.getItem(PANEL_KEY) !== '0'; } catch { return true; }
}

export const useUiStore = create<UiState>((set) => ({
  panelCollapsed: loadPanelCollapsed(),
  setPanelCollapsed: (panelCollapsed): void => {
    try { window.localStorage.setItem(PANEL_KEY, panelCollapsed ? '1' : '0'); } catch { /* session-only */ }
    set({ panelCollapsed });
  },
  paletteOpen: false,
  setPaletteOpen: (paletteOpen): void => { set({ paletteOpen }); },
  draft: false,
  detailsOpen: false,
  detailsTab: 'files',
  collapsedProjects: {},
  collapsedSpaces: {},
  toggleSpace: (id): void => {
    set((state) => ({ collapsedSpaces: { ...state.collapsedSpaces, [id]: !state.collapsedSpaces[id] } }));
  },
  addProjectOpen: false,
  onboardingOpen: false,
  setOnboardingOpen: (onboardingOpen): void => { set({ onboardingOpen }); },
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
