import { create } from 'zustand';

// Presentation-only state for the chat shell: whether the main view shows a
// fresh draft (new thread) instead of the focused task, the right-hand details
// panel, and which sidebar project groups are collapsed. Nothing here is
// durable domain state.

/** A prefilled new-thread message: text, an attached Markdown document, and the issue it is for. */
export interface ComposerSeed {
  workspaceId: string;
  text: string;
  attachment?: { name: string; markdown: string };
  issue?: { number: number };
}

export type DetailsTab = 'plan' | 'checks' | 'files' | 'context' | 'activity';

interface UiState {
  /** True while composing a new thread; the chat view shows the draft hero. */
  draft: boolean;
  /** A message being forked: the chat view shows the conversation up to it and a composer that starts the fork. */
  forkFrom: string | null;
  setForkFrom: (taskId: string | null) => void;
  /** What the next new-thread composer starts with (e.g. a GitHub issue to work on). */
  composerSeed: ComposerSeed | null;
  setComposerSeed: (seed: ComposerSeed | null) => void;
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
  /** The app sidebar is hidden (⌘B). */
  panelCollapsed: boolean;
  /** Where a screen can render its own list inside the sidebar (Agents does). */
  sidebarSlot: HTMLElement | null;
  setSidebarSlot: (slot: HTMLElement | null) => void;
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
  /** Work's thread list shows every project (null) or only this one. */
  workProject: string | null;
  setWorkProject: (id: string | null) => void;
  setAddProjectOpen: (open: boolean) => void;
  setPlanMode: (on: boolean) => void;
}

const PANEL_KEY = 'conductor.sidebar.hidden';
const WORK_PROJECT_KEY = 'conductor.sidebar.workProject';

function loadWorkProject(): string | null {
  try { return window.localStorage.getItem(WORK_PROJECT_KEY); } catch { return null; }
}

function loadPanelCollapsed(): boolean {
  try { return window.localStorage.getItem(PANEL_KEY) === '1'; } catch { return false; }
}

export const useUiStore = create<UiState>((set) => ({
  panelCollapsed: loadPanelCollapsed(),
  setPanelCollapsed: (panelCollapsed): void => {
    try { window.localStorage.setItem(PANEL_KEY, panelCollapsed ? '1' : '0'); } catch { /* session-only */ }
    set({ panelCollapsed });
  },
  sidebarSlot: null,
  setSidebarSlot: (sidebarSlot): void => { set({ sidebarSlot }); },
  paletteOpen: false,
  setPaletteOpen: (paletteOpen): void => { set({ paletteOpen }); },
  draft: false,
  forkFrom: null,
  composerSeed: null,
  setComposerSeed: (composerSeed): void => { set({ composerSeed }); },
  setForkFrom: (forkFrom): void => { set({ forkFrom, draft: false }); },
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
  // Opening a new thread or another thread leaves a pending fork.
  setDraft: (draft): void => { set({ draft, forkFrom: null }); },
  setDetailsOpen: (detailsOpen): void => { set({ detailsOpen }); },
  openDetails: (detailsTab): void => { set({ detailsOpen: true, detailsTab }); },
  toggleProject: (id): void => {
    set((state) => ({ collapsedProjects: { ...state.collapsedProjects, [id]: !state.collapsedProjects[id] } }));
  },
  workProject: loadWorkProject(),
  setWorkProject: (workProject): void => {
    try {
      if (workProject === null) window.localStorage.removeItem(WORK_PROJECT_KEY);
      else window.localStorage.setItem(WORK_PROJECT_KEY, workProject);
    } catch { /* session-only */ }
    set({ workProject });
  },
  setAddProjectOpen: (addProjectOpen): void => { set({ addProjectOpen }); },
  setPlanMode: (planMode): void => { set({ planMode }); },
}));
