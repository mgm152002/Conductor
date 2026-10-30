import { describe, expect, it } from 'vitest';
import type { Task, TaskEvent } from '../../src/shared/domain';
import type { TaskDetails } from '../../src/shared/task-view';
import { buildChatMessageTimeline, buildTimeline, latestActivity, recentActivities } from '../../src/renderer/lib/timeline';
import type { ChatMessage } from '../../src/shared/chat-contract';

const task: Task = { id: 't', workspaceId: 'w', objective: 'Add a test', state: 'COMPLETED', acceptanceCriteria: ['response: nonempty'], contextRefs: [], createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
let n = 0;
const stdout = (line: unknown): TaskEvent => ({ id: `e${n++}`, taskId: 't', kind: 'stream', payload: { kind: 'stdout', data: typeof line === 'string' ? line : JSON.stringify(line) }, createdAt: `2026-10-24T00:00:${String(n).padStart(2, '0')}Z` });
const log = (payload: Record<string, unknown>): TaskEvent => ({ id: `l${n++}`, taskId: 't', kind: 'log', payload, createdAt: `2026-10-24T00:00:${String(n).padStart(2, '0')}Z` });
const streamLog = (data: Record<string, unknown>): TaskEvent => ({ id: `s${n++}`, taskId: 't', kind: 'stream', payload: { kind: 'log', data }, createdAt: `2026-10-24T00:00:${String(n).padStart(2, '0')}Z` });
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

  it('shows what each Codex tool ran and produced, with file names not folder paths', () => {
    const items = buildTimeline(task, details([
      stdout({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: '/w/src/deep/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }] } }),
      stdout({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'github', tool: 'get_issue', status: 'completed', output: 'Issue #4: Bug' } }),
      stdout({ type: 'item.completed', item: { id: 'i1', type: 'image_view', path: '/w/photos/image.png' } }),
    ]));
    const work = items.find((i) => i.kind === 'work') as Extract<typeof items[number], { kind: 'work' }>;
    expect(work.entries[0]).toMatchObject({ label: 'Edited a.ts' });
    expect(work.entries[0]?.detail).toContain('update /w/src/deep/a.ts');
    expect(work.entries[0]?.detail).toContain('+new');
    expect(work.entries[1]).toMatchObject({ label: 'Called github.get_issue', detail: 'Issue #4: Bug' });
    expect(work.entries[2]).toMatchObject({ icon: 'read', label: 'Viewed image.png', detail: '/w/photos/image.png' });
  });

  it('streams reply snapshots into one assistant item and dedupes the final reply', () => {
    const items = buildTimeline(task, details([
      log({ message: 'Hello', kind: 'reply', key: 'codex:reply:m1', status: 'running', source: 'Codex' }),
      log({ message: 'Hello world', kind: 'reply', key: 'codex:reply:m1', status: 'running', source: 'Codex' }),
      stdout({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Hello world' } }),
    ]));
    const replies = items.filter((i) => i.kind === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Hello world' });
  });

  it('updates a running reasoning entry in place instead of stacking rows', () => {
    const items = buildTimeline(task, details([
      log({ message: 'Inspecting', kind: 'reasoning', key: 'acp:thought', status: 'running', source: 'OpenCode' }),
      log({ message: 'Inspecting the parser', kind: 'reasoning', key: 'acp:thought', status: 'neutral', source: 'OpenCode' }),
    ]));
    const work = items.find((i) => i.kind === 'work') as Extract<typeof items[number], { kind: 'work' }>;
    expect(work.entries).toHaveLength(1);
    expect(work.entries[0]).toMatchObject({ label: 'Inspecting the parser', tone: 'neutral' });
  });

  it('shows CLI tool calls carried as log stream events, merging start and completion by key', () => {
    const items = buildTimeline(task, details([
      streamLog({ message: 'Inspecting the renderer', kind: 'reasoning', key: 'acp:thought', status: 'running', source: 'OpenCode' }),
      streamLog({ message: 'read', kind: 'read', detail: 'src/renderer/lib/timeline.ts', key: 'call-1', status: 'running', source: 'OpenCode' }),
      streamLog({ key: 'call-1', status: 'completed', source: 'OpenCode' }),
      streamLog({ usage: { costUsd: 0.12, model: 'test-model' } }),
      streamLog({ message: 'Here is what I found', kind: 'reply', key: 'acp:reply', status: 'running', source: 'OpenCode' }),
      stdout('Here is what I found'),
    ]));
    const work = items.find((i) => i.kind === 'work') as Extract<typeof items[number], { kind: 'work' }>;
    expect(work.entries).toHaveLength(2);
    expect(work.entries[0]).toMatchObject({ label: 'Inspecting the renderer', icon: 'thinking', tone: 'running', source: 'OpenCode' });
    expect(work.entries[1]).toMatchObject({ label: 'read', detail: 'src/renderer/lib/timeline.ts', icon: 'read', tone: 'success', source: 'OpenCode' });
    expect(latestActivity(items)).toMatchObject({ label: 'read', tone: 'success' });
    expect(recentActivities(items, 5).map((entry) => entry.label)).toEqual(['Inspecting the renderer', 'read']);
    const replies = items.filter((i) => i.kind === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Here is what I found' });
  });

  it('keeps ACP prose segments in place around tool calls instead of collapsing them into one reply', () => {
    const items = buildTimeline(task, details([
      log({ message: 'First I will inspect the code.', kind: 'reply', key: 'acp:reply', status: 'running', source: 'OpenCode' }),
      stdout('First I will inspect the code.'),
      log({ message: 'read', kind: 'read', detail: 'src/a.ts', key: 'call-1', status: 'running', source: 'OpenCode' }),
      log({ key: 'call-1', status: 'completed', source: 'OpenCode' }),
      log({ message: 'Found the bug. Fixing it now.', kind: 'reply', key: 'acp:reply', status: 'running', source: 'OpenCode' }),
      stdout('Found the bug. Fixing it now.'),
      log({ message: 'edit', kind: 'edit', detail: 'src/a.ts', key: 'call-2', status: 'completed', source: 'OpenCode' }),
      log({ message: 'All fixed.', kind: 'reply', key: 'acp:reply', status: 'neutral', source: 'OpenCode' }),
    ]));
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'work', 'assistant', 'work', 'assistant']);
    const replies = items.filter((i) => i.kind === 'assistant').map((i) => (i as { text: string }).text);
    expect(replies).toEqual(['First I will inspect the code.', 'Found the bug. Fixing it now.', 'All fixed.']);
  });

  it('starts a new reasoning row for a later thought segment instead of rewriting the earlier one', () => {
    const items = buildTimeline(task, details([
      log({ message: 'Inspecting the parser', kind: 'reasoning', key: 'acp:thought', status: 'neutral', source: 'OpenCode' }),
      log({ message: 'read', kind: 'read', key: 'call-1', status: 'completed', source: 'OpenCode' }),
      log({ message: 'Planning the edit', kind: 'reasoning', key: 'acp:thought', status: 'neutral', source: 'OpenCode' }),
    ]));
    const labels = items.flatMap((i) => (i.kind === 'work' ? i.entries.map((e) => e.label) : []));
    expect(labels).toEqual(['Inspecting the parser', 'read', 'Planning the edit']);
  });

  it('interleaves chat prose and activity by recorded content offset', () => {
    const message: ChatMessage = {
      id: 'm1', threadId: 'c1', role: 'assistant', status: 'complete', createdAt: '2026-10-24T00:00:00Z', attachments: [],
      content: 'Checking first. All finished.',
      activity: [{ id: 'a1', key: 'call-1', label: 'read', kind: 'read', status: 'completed', createdAt: '2026-10-24T00:00:01Z', contentOffset: 'Checking first.'.length }],
    };
    const items = buildChatMessageTimeline(message);
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'work', 'assistant']);
    expect(items[0]).toMatchObject({ text: 'Checking first.' });
    expect(items[2]).toMatchObject({ text: 'All finished.' });
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
