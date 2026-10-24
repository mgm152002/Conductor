// Browser-only fixture: synthetic IPC data, no access to a real workspace or
// agents. Run: npx vite --config test/ui/vite.config.ts
// Open /test/ui/index.html?width=1000&draft=1 to check composer wrapping.
import { createRoot } from 'react-dom/client';
import { App } from '../../src/renderer/App';
import { useTaskStore, useUiStore, useWorkspaceStore } from '../../src/renderer/stores';
import type { Task, Workspace } from '../../src/shared/domain';
import type { TaskDetails } from '../../src/shared/task-view';
import type { ChatConversation, ChatThread } from '../../src/shared/chat-contract';
import '../../src/renderer/index.css';

const params = new URLSearchParams(location.search);
const width = Number(params.get('width'));
if (width > 0) document.getElementById('root')!.style.width = `${width}px`;
const height = Number(params.get('height'));
if (height > 0) document.getElementById('root')!.style.height = `${height}px`;
const createdAt = new Date().toISOString();
const project: Workspace = { id: 'ui-project', name: 'Conductor project with a very long name', rootPath: '/ui-fixture', createdAt, updatedAt: createdAt };
const task: Task = {
  id: 'ui-task', workspaceId: project.id, objective: 'Build the memory and workflow experience', state: 'COMPLETED',
  acceptanceCriteria: ['Memory is searchable by meaning', 'Plan controls fit in a narrow window'], contextRefs: [], createdAt, updatedAt: createdAt,
};
const details: TaskDetails = {
  task, events: [], approvals: [], artifacts: [], verification: null,
  steps: [
    { id: 'first', taskId: task.id, ordinal: 0, description: 'Implement memory retrieval with a long identifier ' + 'memory_scope_'.repeat(18), status: 'succeeded', dependsOn: [], assignedAdapterId: 'codex' },
    { id: 'second', taskId: task.id, ordinal: 1, description: 'Verify the Plan layout', status: 'succeeded', dependsOn: ['first'], assignedAdapterId: 'claude-code' },
  ],
  plan: {
    plannerAdapterId: 'codex', status: 'ready', docsDir: '/ui-fixture/.conductor/plans/ui-task',
    waves: [{ id: 0, tasks: ['1.1'] }, { id: 1, tasks: ['1.2'] }], steps: { '1.1': 'first', '1.2': 'second' },
    plan: {
      title: 'Memory and workflow experience', introduction: '', requirements: [],
      groups: [{ id: '1', title: 'Implementation', tasks: [
        { id: '1.1', title: 'Implement memory retrieval', details: ['Use Mem0 for semantic memory.'], requirements: [], dependsOn: [], agent: 'codex', difficulty: 'complex' },
        { id: '1.2', title: 'Verify the Plan layout', details: [], requirements: [], dependsOn: ['1.1'], agent: 'claude-code', difficulty: 'simple' },
      ] }],
    },
  },
};
const agents = [{ id: 'codex', name: 'Codex', available: true, remote: false }, { id: 'claude-code', name: 'Claude Code', available: true, remote: false }];
const projects = params.has('no-projects') ? [] : [project];
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const chats: Record<string, ChatConversation> = JSON.parse(localStorage.getItem('ui-casual-chats') ?? '{}');
const publish = (snapshot: ChatConversation): void => {
  localStorage.setItem('ui-casual-chats', JSON.stringify(chats));
  for (const listener of listeners.get('chat.updated') ?? []) listener(structuredClone(snapshot));
};
window.conductor = {
  on: (event: string, listener: (payload: unknown) => void) => {
    const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group);
    return () => { group.delete(listener); };
  },
  chat: {
    list: async (): Promise<ChatThread[]> => Object.values(chats).map((chat) => chat.thread),
    get: async (id: string) => structuredClone(chats[id]!),
    send: async (input: { threadId?: string; content: string; agentId?: string }) => {
      const id = input.threadId ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const chat = chats[id] ?? { thread: { id, title: input.content.slice(0, 60), agentId: input.agentId ?? 'codex', createdAt: now, updatedAt: now }, messages: [] };
      chats[id] = chat;
      chat.thread.updatedAt = now;
      chat.messages.push({ id: crypto.randomUUID(), threadId: id, role: 'user', content: input.content, status: 'complete', createdAt: now });
      const reply = { id: crypto.randomUUID(), threadId: id, role: 'assistant' as const, content: '', status: 'streaming' as 'streaming' | 'complete', createdAt: now };
      chat.messages.push(reply);
      publish(chat);
      setTimeout(() => {
        reply.content = chat.messages.length > 2 ? 'Of course. We can keep exploring that idea together.' : 'Absolutely — what would you like to talk about? We can explore ideas, answer questions, or just have a conversation.';
        reply.status = 'complete'; chat.thread.updatedAt = new Date().toISOString(); publish(chat);
      }, 150);
      return structuredClone(chat);
    },
    cancel: async () => {},
  },
  theme: { get: async () => 'light' },
  workspace: { list: async () => projects, active: async () => projects[0]?.id ?? null, select: async () => {} },
  task: { list: async () => [task], listActive: async () => [], get: async () => task, details: async () => details, thread: async () => [task] },
  approval: { list: async () => [] },
  agents: {
    list: async () => agents,
    models: async (agentId: string) => ({ agentId, models: [{ id: 'test-model', label: 'A model with an unusually long descriptive name', tier: 'balanced' }], efforts: ['low', 'medium', 'high', 'xhigh'], source: 'cli' }),
  },
  permissions: { getProfile: async () => 'assisted_execution' },
  dataControl: { listConsents: async () => agents.map((agent) => ({ provider: agent.id })) },
  suggestions: { list: async () => [] },
} as unknown as typeof window.conductor;
useWorkspaceStore.setState({ workspaces: projects, activeWorkspaceId: projects[0]?.id ?? null });
useTaskStore.setState({ tasks: projects.length ? { [task.id]: task } : {}, focusedTaskId: projects.length ? task.id : null });
useUiStore.setState({ draft: params.has('draft') });
createRoot(document.getElementById('root')!).render(<App />);
