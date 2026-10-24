import { useEffect } from 'react';
import type { ChatConversation } from '@shared/chat-contract';
import { useChatStore } from '../stores/chat-store';

/** Remains mounted across Work/Chat so background replies stay in history. */
export function useChatEvents(): void {
  useEffect(() => {
    let active = true;
    const off = window.conductor.on('chat.updated', (payload) => {
      useChatStore.getState().receive(payload as ChatConversation);
    });
    void window.conductor.chat.list().then((threads) => {
      if (active) useChatStore.getState().setThreads(threads);
    }).catch(() => { /* The chat sidebar offers a visible retry. */ });
    return () => { active = false; off(); };
  }, []);
}
