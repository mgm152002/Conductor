import { describe, expect, it } from 'vitest';
import type { Task, TaskEvent } from '../../src/shared/domain';
import type { TaskDetails } from '../../src/shared/task-view';
import { buildTimeline, latestActivity, recentActivities } from '../../src/renderer/lib/timeline';

const task: Task = { id: 't', workspaceId: 'w', objective: 'Add a test', state: 'COMPLETED', acceptanceCriteria: ['response: nonempty'], contextRefs: [], createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
let n = 0;
const stdout = (line: unknown): TaskEvent => ({ id: `e${n++}`, taskId: 't', kind: 'stream', payload: { kind: 'stdout', data: typeof line === 'string' ? line : JSON.stringify(line) }, createdAt: `2026-10-24T00:00:${String(n).padStart(2, '0')}Z` });
const log = (payload: Record<string, unknown>): TaskEvent => ({ id: `l${n++}`, taskId: 't', kind: 'log', payload, createdAt: `2026-10-24T00:00:${String(n).padStart(2, '0')}Z` });
const details = (events: TaskEvent[]): TaskDetails => ({ task, steps: [], events, artifacts: [], attachments: [], approvals: [], verification: null });

describe('chat timeline', () => {
  it('keeps persisted attachment metadata on the user turn after details reload', () => {
    const attachment = {
      id: 'attachment-1', name: 'notes.md', kind: 'markdown' as const,
      mimeType: 'text/markdown', sizeBytes: 42, sha256: 'a'.repeat(64),
      createdAt: '2026-10-24T00:00:00Z',
    };
    const items = buildTimeline(task, { ...details([]), attachments: [attachment] });
    expect(items[0]).toMatchObject({ kind: 'user', attachments: [attachment] });
  });

  it('turns Codex JSONL into work entries and a reply, merging started/completed items', () => {
    const items = buildTimeline(task, details([
      stdout({ type: 'thread.started' }),
      stdout({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "bash -lc 'ls'", status: 'in_progress' } }),
      stdout({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: "bash -lc 'ls'", aggregated_output: 'a.ts', exit_code: 0, status: 'completed' } }),
      stdout({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.test.ts', kind: 'add' }] } }),
      stdout({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done.' } }),
    ]));
    expect(items.map((i) => i.kind)).toEqual(['user', 'work', 'assistant']);
    const work = items[1] as Extract<typeof items[number], { kind: 'work' }>;
    expect(work.entries).toHaveLength(2);
    expect(work.entries[0]).toMatchObject({ icon: 'terminal', label: 'ls', tone: 'success', detail: 'a.ts' });
    expect(work.entries[1]).toMatchObject({ icon: 'file', label: 'Edited a.test.ts' });
    expect(items[2]).toMatchObject({ text: 'Done.' });
  });

  it('shows Codex item notices as neutral, not errors', () => {
    const items = buildTimeline(task, details([stdout({ type: 'item.completed', item: { id: 'n', type: 'error', message: 'Ignoring unknown feature' } })]));
    expect(items.map((i) => i.kind)).toEqual(['user', 'work']);
    expect((items[1] as Extract<typeof items[number], { kind: 'work' }>).entries[0]).toMatchObject({ tone: 'neutral', notice: true });
  });

  it('marks errors before a retry as earlier attempts and surfaces stderr when there is no reply', () => {
    const failed = { ...task, state: 'FAILED' as const };
    const items = buildTimeline(failed, { ...details([
      { id: 'e1', taskId: 't', kind: 'error', payload: { error: 'unroutable' }, createdAt: '2026-10-24T00:00:01Z' },
      { id: 'r', taskId: 't', kind: 'transition', payload: { from: 'BLOCKED', to: 'PLANNING', reason: 'retry' }, createdAt: '2026-10-24T00:00:02Z' },
      { id: 's', taskId: 't', kind: 'stream', payload: { kind: 'stderr', data: 'tool permission auto-denied' }, createdAt: '2026-10-24T00:00:03Z' },
    ]), task: failed });
    const errors = items.filter((i): i is Extract<typeof i, { kind: 'error' }> => i.kind === 'error');
    expect(errors[0]).toMatchObject({ text: 'unroutable', stale: true });
    expect(errors[1]!.text).toContain('tool permission auto-denied');
    expect(errors[1]!.stale).toBeUndefined();
  });

  it('treats plain stdout as reply prose and stderr as collapsed diagnostics', () => {
    const items = buildTimeline(task, details([
      stdout('Line one'), stdout('Line two'),
      { id: 'err', taskId: 't', kind: 'stream', payload: { kind: 'stderr', data: 'warning: x' }, createdAt: '2026-10-24T00:01:00Z' },
    ]));
    expect(items[1]).toMatchObject({ kind: 'assistant', text: 'Line one\nLine two' });
    expect(items[2]).toMatchObject({ kind: 'diagnostics', text: 'warning: x' });
  });

  it('renders an agent switch as a friendly notice, outside the work log', () => {
    const items = buildTimeline(task, details([
      stdout('Working on it'),
      { id: 'f', taskId: 't', kind: 'log', payload: { message: 'OpenCode is out of capacity, so Codex CLI is taking over this step.', agentFallback: true }, createdAt: '2026-10-24T00:00:01Z' },
      stdout('Finished'),
    ]));
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'notice', 'assistant']);
    expect(items[2]).toMatchObject({
      kind: 'notice',
      text: 'OpenCode is out of capacity, so Codex CLI is taking over this step.',
    });
  });

  it('surfaces error events and agent failures as errors', () => {
    const items = buildTimeline(task, details([
      { id: 'x', taskId: 't', kind: 'error', payload: { error: 'No agent available' }, createdAt: '2026-10-24T00:01:00Z' },
      stdout({ type: 'turn.failed', error: { message: 'rate limited' } }),
    ]));
    expect(items.filter((i) => i.kind === 'error').map((i) => (i as { text: string }).text)).toEqual(['No agent available', 'rate limited']);
  });

  it('merges a keyed tool completion after an assistant reply and keeps its source and detail', () => {
    const items = buildTimeline(task, details([
      log({ message: 'Bash', kind: 'execute', detail: 'npm test', key: 'tool-1', status: 'running', source: 'Claude Code' }),
      stdout('Running the suite'),
      log({ message: 'Bash', key: 'tool-1', status: 'completed', source: 'Claude Code' }),
      log({ message: 'The tests pass.\nEverything is green.', kind: 'reasoning', source: 'Claude Code' }),
      stdout('All done.'),
    ]));

    expect(items.map((item) => item.kind)).toEqual(['user', 'work', 'assistant', 'work', 'assistant']);
    const start = (items[1] as Extract<typeof items[number], { kind: 'work' }>).entries[0]!;
    expect(start).toMatchObject({ label: 'Bash', detail: 'npm test', tone: 'success', icon: 'terminal', source: 'Claude Code' });
    expect((items[3] as Extract<typeof items[number], { kind: 'work' }>).entries[0]).toMatchObject({
      label: 'The tests pass.', detail: 'The tests pass.\nEverything is green.', icon: 'thinking', source: 'Claude Code',
    });
    expect((items[4] as Extract<typeof items[number], { kind: 'assistant' }>).text).toBe('All done.');
  });

  it('reports the latest real activity, skipping diagnostic notices', () => {
    const items = buildTimeline(task, details([
      log({ message: 'Read src/a.ts', kind: 'read', status: 'completed', source: 'OpenCode' }),
      stdout({ type: 'item.completed', item: { id: 'n', type: 'error', message: 'Ignoring unknown feature' } }),
    ]));

    expect(latestActivity(items)).toMatchObject({ label: 'Read src/a.ts', icon: 'read', source: 'OpenCode' });
  });

  it('keeps a continuous tail of recent activity instead of one line', () => {
    const items = buildTimeline(task, details([
      log({ message: 'Read src/a.ts', kind: 'read', status: 'completed', source: 'OpenCode' }),
      stdout('Planning the change'),
      log({ message: 'Bash', kind: 'execute', detail: 'npm test', key: 'tool-1', status: 'running', source: 'OpenCode' }),
      stdout({ type: 'item.completed', item: { id: 'n', type: 'error', message: 'Ignoring unknown feature' } }),
      log({ message: 'Edited src/b.ts', kind: 'edit', status: 'completed', source: 'OpenCode' }),
    ]));

    expect(recentActivities(items, 3).map((entry) => entry.label)).toEqual([
      'Read src/a.ts',
      'Bash',
      'Edited src/b.ts',
    ]);
    expect(recentActivities(items, 1).map((entry) => entry.label)).toEqual(['Edited src/b.ts']);
    expect(recentActivities(items, 0)).toEqual([]);
  });
});
