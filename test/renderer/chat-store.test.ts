import { beforeEach, expect, it } from 'vitest';
import { useChatStore } from '../../src/renderer/stores/chat-store';
import type { ChatConversation } from '../../src/shared/chat-contract';

const snapshot = (content = 'Hello', status: 'streaming' | 'complete' = 'streaming', id = 'chat-1'): ChatConversation => ({
  thread: { id, title: content, agentId: 'codex', createdAt: '2026-10-25', updatedAt: '2026-10-25' },
  messages: [{ id: `reply-${id}`, threadId: id, role: 'assistant', content, status, createdAt: '2026-10-25', attachments: [] }],
});
beforeEach(() => { useChatStore.setState({ threads: [], conversations: {}, selectedId: null, drafts: {} }); });

it('keeps casual history and independent drafts when starting a new chat', () => {
  const store = useChatStore.getState();
  store.receive(snapshot());
  store.select('chat-1');
  store.setDraft('chat-1', 'Follow up');
  store.select(null);
  store.setDraft('new', 'New question');
  expect(useChatStore.getState().threads).toHaveLength(1);
  expect(useChatStore.getState().selectedId).toBeNull();
  expect(useChatStore.getState().drafts).toEqual({ 'chat-1': 'Follow up', new: 'New question' });
});

it('does not roll a completed streaming reply back when the send snapshot arrives late', () => {
  useChatStore.getState().receive(snapshot('Hello there', 'complete'));
  useChatStore.getState().receive(snapshot('Hello', 'streaming'));
  expect(useChatStore.getState().conversations['chat-1']?.messages[0]?.content).toBe('Hello there');
  expect(useChatStore.getState().conversations['chat-1']?.messages[0]?.status).toBe('complete');
});

it('applies a rename to the history entry and the loaded conversation', () => {
  const store = useChatStore.getState();
  store.receive(snapshot('First chat'));
  store.receive(snapshot('Second chat', 'complete', 'chat-2'));

  store.rename({ id: 'chat-1', title: 'Renamed chat', agentId: 'codex', createdAt: '2026-10-25', updatedAt: '2026-10-25' });

  expect(useChatStore.getState().threads.find((t) => t.id === 'chat-1')?.title).toBe('Renamed chat');
  expect(useChatStore.getState().threads.find((t) => t.id === 'chat-2')?.title).toBe('Second chat');
  expect(useChatStore.getState().conversations['chat-1']?.thread.title).toBe('Renamed chat');
  expect(useChatStore.getState().conversations['chat-1']?.messages[0]?.content).toBe('First chat');
});

it('removes cached chat state and clears the selection only for the selected thread', () => {
  const store = useChatStore.getState();
  store.receive(snapshot('First chat'));
  store.receive(snapshot('Second chat', 'complete', 'chat-2'));
  store.setDraft('chat-1', 'First draft');
  store.setDraft('chat-2', 'Second draft');
  store.select('chat-2');

  store.remove('chat-1');

  expect(useChatStore.getState()).toMatchObject({
    threads: [expect.objectContaining({ id: 'chat-2' })],
    conversations: { 'chat-2': expect.any(Object) },
    drafts: { 'chat-2': 'Second draft' },
    selectedId: 'chat-2',
  });
  expect(useChatStore.getState().conversations).not.toHaveProperty('chat-1');
  expect(useChatStore.getState().drafts).not.toHaveProperty('chat-1');

  useChatStore.getState().remove('chat-2');

  expect(useChatStore.getState()).toMatchObject({
    threads: [],
    conversations: {},
    drafts: {},
    selectedId: null,
  });
});
