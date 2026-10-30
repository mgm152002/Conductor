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

vi.mock('../../src/renderer/stores/workspace-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/stores/workspace-store')>();
  const renderStore = Object.assign(
    (<T,>(selector: (state: ReturnType<typeof actual.useWorkspaceStore.getState>) => T): T => selector(actual.useWorkspaceStore.getState())),
    actual.useWorkspaceStore,
  ) as typeof actual.useWorkspaceStore;
  return { ...actual, useWorkspaceStore: renderStore };
});

vi.mock('../../src/renderer/stores/question-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/stores/question-store')>();
  const renderStore = Object.assign(
    (<T,>(selector: (state: ReturnType<typeof actual.useQuestionStore.getState>) => T): T => selector(actual.useQuestionStore.getState())),
    actual.useQuestionStore,
  ) as typeof actual.useQuestionStore;
  return { ...actual, useQuestionStore: renderStore };
});

vi.mock('../../src/renderer/stores/thread-tier-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/stores/thread-tier-store')>();
  const renderStore = Object.assign(
    (<T,>(selector: (state: ReturnType<typeof actual.useThreadTierStore.getState>) => T): T => selector(actual.useThreadTierStore.getState())),
    actual.useThreadTierStore,
  ) as typeof actual.useThreadTierStore;
  return { ...actual, useThreadTierStore: renderStore };
});

vi.mock('../../src/renderer/stores/task-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/stores/task-store')>();
  const renderStore = Object.assign(
    (<T,>(selector: (state: ReturnType<typeof actual.useTaskStore.getState>) => T): T => selector(actual.useTaskStore.getState())),
    actual.useTaskStore,
  ) as typeof actual.useTaskStore;
  return { ...actual, useTaskStore: renderStore };
});

import { CasualChat } from '../../src/renderer/components/chat/CasualChat';
import { Sidebar } from '../../src/renderer/components/Sidebar';
import { useChatStore } from '../../src/renderer/stores/chat-store';
import { useApprovalStore } from '../../src/renderer/stores/approval-store';
import { useQuestionStore } from '../../src/renderer/stores/question-store';
import { useTaskStore } from '../../src/renderer/stores/task-store';
import { useThreadTierStore } from '../../src/renderer/stores/thread-tier-store';
import { useWorkspaceStore } from '../../src/renderer/stores/workspace-store';
import type { ChatConversation } from '../../src/shared/chat-contract';

const conversation: ChatConversation = {
  thread: { id: 'chat-1', title: 'Saved chat', agentId: 'codex', createdAt: '2026-10-25', updatedAt: '2026-10-25' },
  messages: [{ id: 'reply', threadId: 'chat-1', role: 'assistant', content: 'Saved reply', status: 'complete', createdAt: '2026-10-25', attachments: [] }],
};

beforeEach(() => {
  useChatStore.setState({ threads: [], spaces: [], conversations: {}, selectedId: null, drafts: {} });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTaskStore.setState({ tasks: {}, focusedTaskId: null, detailsRevision: {} });
  useApprovalStore.setState({ pending: [] });
  useQuestionStore.setState({ pending: [] });
  useThreadTierStore.setState({ prefs: {} });
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

it('offers rename actions for populated Chat history and the open chat', () => {
  useChatStore.getState().receive(conversation);
  useChatStore.getState().select('chat-1');

  const sidebar = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(Sidebar)));
  expect(sidebar).toContain('aria-label="Rename chat: Saved chat"');

  const open = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(CasualChat)));
  expect(open).toContain('aria-label="Rename chat: Saved chat"');
});

it('renders personal chats as draggable with space and ungrouped drop targets', () => {
  useChatStore.setState({
    spaces: [{ id: 'space-1', name: 'Trip planning', createdAt: '2026-10-25', updatedAt: '2026-10-25', threadCount: 1 }],
    threads: [
      { id: 'chat-1', title: 'Lisbon chat', agentId: 'codex', createdAt: '2026-10-25', updatedAt: '2026-10-25', spaceId: 'space-1' },
      { id: 'chat-2', title: 'Loose chat', agentId: 'codex', createdAt: '2026-10-25', updatedAt: '2026-10-25', spaceId: null },
    ],
  });

  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(Sidebar)));

  // Rows carry the drag source, spaces and the ungrouped Chats list the targets:
  // dropping on a space calls chat.setThreadSpace(id, spaceId); dropping on
  // Chats calls it with null, which stops context sharing in both directions.
  expect(html).toContain('data-chat-thread-id="chat-1"');
  expect(html).toContain('draggable="true"');
  expect(html).toContain('data-chat-space-id="space-1"');
  expect(html).toContain('data-chat-ungrouped-drop-target=""');
  expect(html).toContain('Drag into a space to share context');
});

it('shows the renamed Work thread title with a rename action in the sidebar', () => {
  const project = { id: 'project-1', name: 'Project', rootPath: '/project', createdAt: '2026-10-25', updatedAt: '2026-10-25' };
  useWorkspaceStore.setState({ workspaces: [project], activeWorkspaceId: project.id });
  useTaskStore.setState({
    tasks: {
      'task-1': {
        id: 'task-1', workspaceId: project.id, objective: 'Original objective', title: 'Renamed thread',
        acceptanceCriteria: [], state: 'COMPLETED', contextRefs: [], createdAt: '2026-10-25', updatedAt: '2026-10-25',
      },
    },
    focusedTaskId: 'task-1',
  });

  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/work'] }, createElement(Sidebar)));

  expect(html).toContain('Renamed thread');
  expect(html).toContain('aria-label="Rename thread: Renamed thread"');
  expect(html).toContain('aria-label="Pull requests for Project"');
  expect(html).not.toContain('Original objective<');
});

it('groups Work threads into tiers with Needs attention first and settled threads behind a collapsible list', () => {
  const project = { id: 'project-1', name: 'Project', rootPath: '/project', createdAt: '2026-10-25', updatedAt: '2026-10-25' };
  useWorkspaceStore.setState({ workspaces: [project], activeWorkspaceId: project.id });
  const base = { workspaceId: project.id, acceptanceCriteria: [], contextRefs: [], createdAt: '2026-10-25', updatedAt: '2026-10-25' };
  useTaskStore.setState({
    tasks: {
      'task-done': { ...base, id: 'task-done', objective: 'Finished thread', state: 'COMPLETED' },
      'task-live': { ...base, id: 'task-live', objective: 'Live thread', state: 'RUNNING' },
      'task-old': { ...base, id: 'task-old', objective: 'Old finished thread', state: 'COMPLETED' },
    },
    focusedTaskId: 'task-done',
  });
  useThreadTierStore.getState().markSettled('task-old', '2026-10-25');

  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/work'] }, createElement(Sidebar)));

  // Needs attention pops up first, before Working.
  expect(html.indexOf('Needs attention')).toBeGreaterThan(-1);
  expect(html.indexOf('Needs attention')).toBeLessThan(html.indexOf('Working'));
  expect(html).toContain('Finished thread');
  expect(html).toContain('Completed');
  expect(html).toContain('Live thread');
  // A thread can be marked settled or snoozed from its row.
  expect(html).toContain('aria-label="Mark thread as settled: Finished thread"');
  expect(html).toContain('aria-label="Snooze thread: Finished thread"');
  // Settled threads are hidden behind their collapsible list.
  expect(html).toContain('aria-label="Settled threads in Project"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Old finished thread');
});

it('makes every tier section collapsible and shows the snooze timer countdown on a snoozed thread', () => {
  const project = { id: 'project-1', name: 'Project', rootPath: '/project', createdAt: '2026-10-25', updatedAt: '2026-10-25' };
  useWorkspaceStore.setState({ workspaces: [project], activeWorkspaceId: project.id });
  useTaskStore.setState({
    tasks: {
      'task-1': {
        id: 'task-1', workspaceId: project.id, objective: 'Snoozed thread',
        acceptanceCriteria: [], state: 'COMPLETED', contextRefs: [], createdAt: '2026-10-25', updatedAt: '2026-10-25',
      },
      'task-2': {
        id: 'task-2', workspaceId: project.id, objective: 'Finished thread',
        acceptanceCriteria: [], state: 'COMPLETED', contextRefs: [], createdAt: '2026-10-25', updatedAt: '2026-10-25',
      },
    },
    focusedTaskId: 'task-1',
  });
  useThreadTierStore.getState().snooze('task-1', '2026-10-25', '2099-01-01T09:00:00.000Z');

  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/work'] }, createElement(Sidebar)));

  // Needs attention is a collapsible section like the other tiers.
  expect(html).toContain('aria-label="Needs attention threads in Project"');
  expect(html).toContain('aria-label="Snoozed threads in Project"');
  // The snoozed (focused, so visible) thread shows its wake timer counting down.
  expect(html).toContain('Snoozed thread');
  expect(html).toContain('wakes in');
});

it('surfaces a thread with a question requiring an answer in Needs attention', () => {
  const project = { id: 'project-1', name: 'Project', rootPath: '/project', createdAt: '2026-10-25', updatedAt: '2026-10-25' };
  useWorkspaceStore.setState({ workspaces: [project], activeWorkspaceId: project.id });
  useTaskStore.setState({
    tasks: {
      'task-1': {
        id: 'task-1', workspaceId: project.id, objective: 'Question thread',
        acceptanceCriteria: [], state: 'RUNNING', contextRefs: [], createdAt: '2026-10-25', updatedAt: '2026-10-25',
      },
    },
    focusedTaskId: null,
  });
  useQuestionStore.setState({
    pending: [{
      id: 'question-1', taskId: 'task-1', agent: 'codex', status: 'pending', createdAt: '2026-10-25',
      questions: [{ id: 'q1', question: 'Which option?' }],
    }],
  });

  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/work'] }, createElement(Sidebar)));

  expect(html).toContain('Needs attention');
  expect(html).toContain('Needs answer');
  expect(html).toContain('Question thread');
});

it('lists every project in the GitHub settings, not just the active one', async () => {
  const { GitHubSettings } = await import('../../src/renderer/components/settings/GitHubSettings');
  useWorkspaceStore.setState({
    workspaces: [
      { id: 'project-1', name: 'Alpha project', rootPath: '/alpha', createdAt: '2026-10-25', updatedAt: '2026-10-25' },
      { id: 'project-2', name: 'Beta project', rootPath: '/beta', createdAt: '2026-10-25', updatedAt: '2026-10-25' },
    ],
    activeWorkspaceId: 'project-1',
  });

  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(GitHubSettings)));
  expect(html).toContain('Alpha project');
  expect(html).toContain('Beta project');
});

it('shows a pull request icon next to a Work thread that has a PR', () => {
  const project = { id: 'project-1', name: 'Project', rootPath: '/project', createdAt: '2026-10-25', updatedAt: '2026-10-25' };
  useWorkspaceStore.setState({ workspaces: [project], activeWorkspaceId: project.id });
  useTaskStore.setState({
    tasks: {
      'task-1': {
        id: 'task-1', workspaceId: project.id, objective: 'Ship the feature',
        acceptanceCriteria: [], state: 'COMPLETED', contextRefs: [], createdAt: '2026-10-25', updatedAt: '2026-10-25',
        prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7', prState: 'open',
      },
    },
    focusedTaskId: 'task-1',
  });

  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/work'] }, createElement(Sidebar)));
  expect(html).toContain('aria-label="Open pull request #7 for thread: Ship the feature"');
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
