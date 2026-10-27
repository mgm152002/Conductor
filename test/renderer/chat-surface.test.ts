import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/stores/chat-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/stores/chat-store')>();
  const renderStore = Object.assign(
    (<T,>(selector: (state: ReturnType<typeof actual.useChatStore.getState>) => T): T => selector(actual.useChatStore.getState())),
    actual.useChatStore,
  ) as typeof actual.useChatStore;
  return { ...actual, useChatStore: renderStore };
});

import { CasualChat } from '../../src/renderer/components/chat/CasualChat';
import { Sidebar } from '../../src/renderer/components/Sidebar';
import { useChatStore } from '../../src/renderer/stores/chat-store';
import { useWorkspaceStore } from '../../src/renderer/stores/workspace-store';
import type { ChatConversation } from '../../src/shared/chat-contract';

const conversation: ChatConversation = {
  thread: { id: 'chat-1', title: 'Saved chat', agentId: 'codex', createdAt: '2026-10-25', updatedAt: '2026-10-25' },
  messages: [{ id: 'reply', threadId: 'chat-1', role: 'assistant', content: 'Saved reply', status: 'complete', createdAt: '2026-10-25', attachments: [] }],
};

beforeEach(() => {
  useChatStore.setState({ threads: [], conversations: {}, selectedId: null, drafts: {} });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
});

it('offers simple casual Chat without requiring a project or exposing task controls', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(CasualChat)));
  expect(html).toContain('What’s on your mind?');
  expect(html).toContain('Ask anything');
  expect(html).not.toContain('task-objective');
  expect(html).not.toContain('Add a project');
  expect(html).not.toContain('Acceptance criteria');
});

it('shows casual history only in Chat, and project navigation only in Work', () => {
  const sidebar = (route: string): string => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [route] }, createElement(Sidebar)));
  const chat = sidebar('/home');
  expect(chat).toContain('New chat');
  expect(chat).toContain('Your conversations will appear here.');
  expect(chat).not.toContain('Add project');
  expect(chat).not.toContain('Workflows');
  const work = sidebar('/work');
  expect(work).toContain('New thread');
  expect(work).toContain('Add project');
  expect(work).not.toContain('Your conversations will appear here.');
});

it('offers a delete action for populated Chat history', () => {
  useChatStore.getState().receive(conversation);

  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(Sidebar)));

  expect(html).toContain('Saved chat');
  expect(html).toContain('aria-label="Delete chat: Saved chat"');
});

it('shows the empty new-chat state after the selected chat is removed from the store', () => {
  useChatStore.getState().receive(conversation);
  useChatStore.getState().select('chat-1');
  const populated = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(CasualChat)));
  expect(populated).toContain('Saved reply');
  expect(populated).not.toContain('What’s on your mind?');

  useChatStore.getState().remove('chat-1');
  const empty = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(CasualChat)));

  expect(empty).toContain('What’s on your mind?');
  expect(empty).not.toContain('Saved reply');
  expect(empty).not.toContain('aria-label="Delete chat: Saved chat"');
});

it('shows reasoning and tool activity in a casual Chat thread', () => {
  useChatStore.getState().receive({
    thread: { id: 'chat-live', title: 'Verbose chat', agentId: 'codex', createdAt: '2026-10-26', updatedAt: '2026-10-26' },
    messages: [{
      id: 'reply-live', threadId: 'chat-live', role: 'assistant', content: 'Finished answer', status: 'complete', createdAt: '2026-10-26', attachments: [],
      activity: [
        { id: 'a1', label: 'Inspecting the request.', kind: 'reasoning', status: 'neutral', source: 'Codex', createdAt: '2026-10-26T00:00:01Z' },
        { id: 'a2', key: 'tool-1', label: 'Read', kind: 'read', detail: '/tmp/notes.md', status: 'completed', source: 'Codex', createdAt: '2026-10-26T00:00:02Z' },
      ],
    }],
  });
  useChatStore.getState().select('chat-live');

  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(CasualChat)));

  expect(html).toContain('Inspecting the request.');
  expect(html).toContain('Read');
  expect(html).toContain('Codex');
  expect(html).toContain('Finished answer');
});
