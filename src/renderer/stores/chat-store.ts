import { create } from 'zustand';
import type { ChatConversation, ChatThread } from '@shared/chat-contract';

interface ChatState {
  threads: ChatThread[];
  conversations: Record<string, ChatConversation>;
  selectedId: string | null;
  drafts: Record<string, string>;
  select: (id: string | null) => void;
  remove: (threadId: string) => void;
  setDraft: (id: string, content: string) => void;
  setThreads: (threads: ChatThread[]) => void;
  receive: (conversation: ChatConversation) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  threads: [], conversations: {}, selectedId: null, drafts: {},
  select: (selectedId) => { set({ selectedId }); },
  remove: (threadId) => { set((state) => {
    const { [threadId]: _conversation, ...conversations } = state.conversations;
    const { [threadId]: _draft, ...drafts } = state.drafts;
    return {
      threads: state.threads.filter((thread) => thread.id !== threadId),
      conversations,
      drafts,
      selectedId: state.selectedId === threadId ? null : state.selectedId,
    };
  }); },
  setDraft: (id, content) => { set((state) => ({ drafts: { ...state.drafts, [id]: content } })); },
  setThreads: (threads) => { set((state) => {
    const merged = new Map(threads.map((thread) => [thread.id, thread]));
    for (const thread of state.threads) {
      const incoming = merged.get(thread.id);
      if (!incoming || incoming.updatedAt <= thread.updatedAt) merged.set(thread.id, thread);
    }
    return { threads: [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }); },
  receive: (incoming) => { set((state) => {
    const previous = state.conversations[incoming.thread.id];
    if (previous && (previous.messages.length > incoming.messages.length || previous.thread.updatedAt > incoming.thread.updatedAt)) return state;
    // IPC replies and live events can cross. Preserve the more advanced reply.
    const messages = incoming.messages.map((message) => {
      const old = previous?.messages.find((item) => item.id === message.id);
      if (old && message.status === 'streaming' && (old.status !== 'streaming' || old.content.length > message.content.length)) return old;
      return message;
    });
    return {
      conversations: { ...state.conversations, [incoming.thread.id]: { ...incoming, messages } },
      threads: [...state.threads.filter((thread) => thread.id !== incoming.thread.id), incoming.thread].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }); },
}));
