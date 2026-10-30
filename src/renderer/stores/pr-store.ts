import { create } from 'zustand';

// Open pull-request reader tabs. Clicking a PR anywhere in the app opens (or
// focuses) a tab here instead of leaving for github.com; tabs live only for
// the session, like browser tabs.

export interface PrTab {
  workspaceId: string;
  number: number;
  title?: string;
}

interface PrState {
  tabs: PrTab[];
  openTab: (tab: PrTab) => void;
  closeTab: (workspaceId: string, number: number) => PrTab[];
  setTitle: (workspaceId: string, number: number, title: string) => void;
}

export const usePrStore = create<PrState>((set, get) => ({
  tabs: [],
  openTab: (tab): void => {
    set((state) => {
      const existing = state.tabs.find((t) => t.workspaceId === tab.workspaceId && t.number === tab.number);
      if (existing !== undefined) {
        return { tabs: state.tabs.map((t) => (t === existing ? { ...t, ...(tab.title !== undefined ? { title: tab.title } : {}) } : t)) };
      }
      return { tabs: [...state.tabs, tab] };
    });
  },
  closeTab: (workspaceId, number): PrTab[] => {
    const tabs = get().tabs.filter((t) => !(t.workspaceId === workspaceId && t.number === number));
    set({ tabs });
    return tabs;
  },
  setTitle: (workspaceId, number, title): void => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.workspaceId === workspaceId && t.number === number ? { ...t, title } : t)),
    }));
  },
}));
