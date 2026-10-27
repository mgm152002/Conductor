import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task, TaskEvent, TaskStep } from '../../src/shared/domain';
import type { TaskDetails } from '../../src/shared/task-view';
import type { TaskPlanView } from '../../src/shared/plan';
import { LiveActivityFeed } from '../../src/renderer/components/chat/LiveActivityFeed';
import { PlanDock } from '../../src/renderer/components/chat/PlanDock';

const task: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  objective: 'Add notes',
  state: 'RUNNING',
  acceptanceCriteria: ['response: nonempty'],
  contextRefs: [],
  createdAt: '2026-10-26T00:00:00Z',
  updatedAt: '2026-10-26T00:00:10Z',
};

const step = (id: string, ordinal: number, status: TaskStep['status'], description: string): TaskStep => ({
  id, taskId: task.id, ordinal, description, dependsOn: [], status, assignedAdapterId: 'opencode',
});

const event = (id: string, kind: TaskEvent['kind'], payload: unknown, createdAt: string): TaskEvent => ({ id, taskId: task.id, kind, payload, createdAt });

function details(overrides: Partial<TaskDetails> = {}): TaskDetails {
  return {
    task,
    steps: [],
    events: [],
    artifacts: [],
    attachments: [],
    approvals: [],
    verification: null,
    ...overrides,
  };
}

describe('live activity feed', () => {
  it('streams several recent CLI steps instead of only the latest line', () => {
    const html = renderToStaticMarkup(createElement(LiveActivityFeed, {
      task,
      details: details({
        steps: [step('s1', 0, 'running', 'Run the tests')],
        events: [
          event('e1', 'log', { message: 'Read src/a.ts', kind: 'read', status: 'completed', source: 'OpenCode' }, '2026-10-26T00:00:01Z'),
          event('e2', 'log', { message: 'Bash', kind: 'execute', detail: 'npm test', key: 'tool-1', status: 'running', source: 'OpenCode' }, '2026-10-26T00:00:02Z'),
          event('e3', 'log', { message: 'Edited src/b.ts', kind: 'edit', status: 'completed', source: 'OpenCode' }, '2026-10-26T00:00:03Z'),
        ],
      }),
    }));

    expect(html).toContain('Live CLI activity');
    expect(html).toContain('1 agent working');
    expect(html).toContain('Read src/a.ts');
    expect(html).toContain('Bash');
    expect(html).toContain('Edited src/b.ts');
    expect(html).toContain('OpenCode');
  });

  it('disappears when the task is no longer working', () => {
    const html = renderToStaticMarkup(createElement(LiveActivityFeed, {
      task: { ...task, state: 'COMPLETED' },
      details: details(),
    }));
    expect(html).toBe('');
  });
});

describe('pinned plan dock', () => {
  it('shows a collapsed plan summary and keeps the task list behind the toggle', () => {
    const plan: TaskPlanView = {
      plannerAdapterId: 'opencode',
      status: 'ready',
      waves: [{ id: 0, tasks: ['1.1', '1.2'] }],
      steps: { '1.1': 's1', '1.2': 's2' },
      plan: {
        title: 'Notes experience',
        introduction: '',
        requirements: [],
        groups: [{
          id: '1',
          title: 'Implementation',
          tasks: [
            { id: '1.1', title: 'Build the store', details: ['Use Mem0 for semantic memory.'], requirements: [], dependsOn: [], agent: 'opencode', difficulty: 'moderate' },
            { id: '1.2', title: 'Build the list view', details: [], requirements: [], dependsOn: [], agent: 'opencode', difficulty: 'simple' },
          ],
        }],
      },
    };
    const html = renderToStaticMarkup(createElement(PlanDock, {
      task,
      details: details({
        steps: [step('s1', 0, 'succeeded', 'Build the store'), step('s2', 1, 'pending', 'Build the list view')],
        plan,
      }),
    }));

    expect(html).toContain('Pinned plan tasks');
    expect(html).toContain('Notes experience');
    expect(html).toContain('1/2 done');
    expect(html).toContain('Click to view tasks and status');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Use Mem0 for semantic memory.');
  });
});
