import { create } from 'zustand';
import type { ApprovalRequest } from '@shared/domain';

// Renderer-side queue of pending approval requests. The main process pushes a
// request via the `approval.requested` event; the UI surfaces it and calls
// `window.conductor.approval.resolve` to approve or deny. Resolved requests are
// removed from the queue here when the backend confirms the decision.

interface ApprovalState {
  pending: ApprovalRequest[];
  setPending: (requests: ApprovalRequest[]) => void;
  push: (request: ApprovalRequest) => void;
  remove: (approvalId: string) => void;
  clear: () => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  pending: [],
  setPending: (requests): void => { set({ pending: requests.filter((request) => request.status === 'pending') }); },
  push: (request): void => {
    set((state) => {
      const index = state.pending.findIndex((r) => r.id === request.id);
      if (index === -1) {
        return { pending: [...state.pending, request] };
      }
      const next = state.pending.slice();
      next[index] = request;
      return { pending: next };
    });
  },
  remove: (approvalId): void => {
    set((state) => ({
      pending: state.pending.filter((r) => r.id !== approvalId),
    }));
  },
  clear: (): void => {
    set({ pending: [] });
  },
}));
