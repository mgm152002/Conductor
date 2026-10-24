import type { WebContents } from 'electron';
import type { ChatConversation } from '@shared/chat-contract';
import { CHAT_SCHEMAS } from '@shared/chat-contract';
import type { ChatService } from '../domain/chat-service';
import type { IpcRouter } from './router';

export function registerChatHandlers(router: IpcRouter, chat: ChatService): void {
  router.handle('chat.list', CHAT_SCHEMAS['chat.list'], () => chat.list());
  router.handle('chat.get', CHAT_SCHEMAS['chat.get'], (_event, { threadId }) => chat.get(threadId));
  router.handle('chat.send', CHAT_SCHEMAS['chat.send'], (_event, input) => chat.send(input));
  router.handle('chat.cancel', CHAT_SCHEMAS['chat.cancel'], (_event, { threadId }) => chat.cancel(threadId));
  router.handle('chat.delete', CHAT_SCHEMAS['chat.delete'], (_event, { threadId }) => chat.delete(threadId));
  router.handle('chat.mem0Health', CHAT_SCHEMAS['chat.mem0Health'], () => chat.mem0Health());
}

export class IpcChatEventEmitter {
  private getWebContents: () => WebContents | null = () => null;

  constructor(private readonly router: IpcRouter) {}

  setWebContentsResolver(resolver: () => WebContents | null): void {
    this.getWebContents = resolver;
  }

  emit(snapshot: ChatConversation): void {
    try {
      const target = this.getWebContents();
      if (target && !target.isDestroyed()) this.router.emit(target, 'chat.updated', snapshot);
    } catch { /* A closed renderer cannot fail a conversation. */ }
  }
}
