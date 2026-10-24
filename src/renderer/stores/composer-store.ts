import { create } from 'zustand';
import type { RunChoice } from '@shared/agent-models';

const STORAGE_KEY = 'conductor.composer-selection';

interface PersistedComposerState {
  agentId: string;
  mainChoice: RunChoice;
  agentChoices: Record<string, RunChoice>;
}

export interface ComposerState extends PersistedComposerState {
  setAgentId: (agentId: string) => void;
  setMainChoice: (mainChoice: RunChoice) => void;
  setAgentChoice: (agentId: string, choice: RunChoice) => void;
  reset: () => void;
}

const initialState: PersistedComposerState = {
  agentId: '',
  mainChoice: {},
  agentChoices: {},
};

function loadState(): PersistedComposerState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as Partial<PersistedComposerState>;
    return {
      agentId: typeof parsed.agentId === 'string' ? parsed.agentId : initialState.agentId,
      mainChoice: parsed.mainChoice && typeof parsed.mainChoice === 'object' ? parsed.mainChoice : initialState.mainChoice,
      agentChoices: parsed.agentChoices && typeof parsed.agentChoices === 'object' ? parsed.agentChoices : initialState.agentChoices,
    };
  } catch {
    return initialState;
  }
}

function saveState(state: PersistedComposerState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable in restricted or privacy-mode contexts.
  }
}

const persisted = loadState();

export const useComposerStore = create<ComposerState>((set) => ({
  ...persisted,
  setAgentId: (agentId): void => {
    set((state) => {
      const next = { ...state, agentId };
      saveState(next);
      return { agentId };
    });
  },
  setMainChoice: (mainChoice): void => {
    set((state) => {
      const next = { ...state, mainChoice };
      saveState(next);
      return { mainChoice };
    });
  },
  setAgentChoice: (agentId, choice): void => {
    set((state) => {
      const agentChoices = { ...state.agentChoices, [agentId]: choice };
      const next = { ...state, agentChoices };
      saveState(next);
      return { agentChoices };
    });
  },
  reset: (): void => {
    set(() => {
      saveState(initialState);
      return initialState;
    });
  },
}));
