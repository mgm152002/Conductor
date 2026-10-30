import { create } from 'zustand';
import type { RunChoice } from '@shared/agent-models';

const STORAGE_KEY = 'conductor.composer-selection';

interface PersistedComposerState {
  agentId: string;
  mainChoice: RunChoice;
  agentChoices: Record<string, RunChoice>;
  /** Personal-chat CLI pick. Persisted so sending a message (or switching threads) never clears it. */
  chatAgentId: string;
  /** Personal-chat model/effort per CLI, so switching CLI keeps each one's selection. */
  chatChoices: Record<string, RunChoice>;
}

export interface ComposerState extends PersistedComposerState {
  setAgentId: (agentId: string) => void;
  setMainChoice: (mainChoice: RunChoice) => void;
  setAgentChoice: (agentId: string, choice: RunChoice) => void;
  setChatAgentId: (agentId: string) => void;
  setChatChoice: (agentId: string, choice: RunChoice) => void;
  reset: () => void;
}

const initialState: PersistedComposerState = {
  agentId: '',
  mainChoice: {},
  agentChoices: {},
  chatAgentId: '',
  chatChoices: {},
};

function loadState(): PersistedComposerState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as Partial<PersistedComposerState>;
    const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : initialState.agentId;
    const mainChoice = parsed.mainChoice && typeof parsed.mainChoice === 'object' ? parsed.mainChoice : initialState.mainChoice;
    const agentChoices = parsed.agentChoices && typeof parsed.agentChoices === 'object' ? { ...parsed.agentChoices } : {};
    // Migration: the main model/effort used to be one global choice. It
    // belonged to the then-chosen agent, so seed that agent's per-agent
    // choice with it instead of dropping the user's pick on upgrade.
    if (Object.keys(mainChoice).length > 0 && agentId !== '' && agentChoices[agentId] === undefined) {
      agentChoices[agentId] = mainChoice;
    }
    return {
      agentId,
      mainChoice,
      agentChoices,
      chatAgentId: typeof parsed.chatAgentId === 'string' ? parsed.chatAgentId : initialState.chatAgentId,
      chatChoices: parsed.chatChoices && typeof parsed.chatChoices === 'object' ? parsed.chatChoices : initialState.chatChoices,
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
  setChatAgentId: (chatAgentId): void => {
    set((state) => {
      const next = { ...state, chatAgentId };
      saveState(next);
      return { chatAgentId };
    });
  },
  setChatChoice: (agentId, choice): void => {
    set((state) => {
      const chatChoices = { ...state.chatChoices, [agentId]: choice };
      const next = { ...state, chatChoices };
      saveState(next);
      return { chatChoices };
    });
  },
  reset: (): void => {
    set(() => {
      saveState(initialState);
      return initialState;
    });
  },
}));
