import { create } from 'zustand';
import type { AgentQuestionRequest } from '@shared/domain';

// Agent questions awaiting human review. The main process pushes them over
// `question.requested`; answering round-trips through `question.answer` and
// the waiting agent continues with the user's choices.

interface QuestionState {
  pending: AgentQuestionRequest[];
  setPending: (requests: AgentQuestionRequest[]) => void;
  push: (request: AgentQuestionRequest) => void;
  remove: (id: string) => void;
}

export const useQuestionStore = create<QuestionState>((set) => ({
  pending: [],
  setPending: (requests): void => { set({ pending: requests.filter((r) => r.status === 'pending') }); },
  push: (request): void => {
    set((state) => request.status !== 'pending'
      ? { pending: state.pending.filter((r) => r.id !== request.id) }
      : { pending: [...state.pending.filter((r) => r.id !== request.id), request] });
  },
  remove: (id): void => { set((state) => ({ pending: state.pending.filter((r) => r.id !== id) })); },
}));
