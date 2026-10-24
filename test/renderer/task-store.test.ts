import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/domain';
import { isTerminalTask, tasksForWorkspace, useTaskStore } from '../../src/renderer/stores/task-store';

const at = '2026-10-25T03:00:00.000Z';
function task(id: string, state: Task['state'] = 'CREATED', workspaceId = 'workspace-a', updatedAt = at): Task {
  return { id, state, workspaceId, objective: id, acceptanceCriteria: [], contextRefs: [], createdAt: at, updatedAt };
}

beforeEach(() => useTaskStore.getState().clear());

describe('task snapshots and selection', () => {
  it('keeps a newer live event when a stale create reply or list arrives', () => {
    const store = useTaskStore.getState();
    store.upsert(task('one', 'RUNNING', 'workspace-a', '2026-10-25T03:00:00.001Z'));
    store.upsert(task('one'));
    store.setTasks([task('one')]);
    expect(useTaskStore.getState().tasks['one']?.state).toBe('RUNNING');
  });
  it('does not roll back a fast lifecycle event with a same-millisecond create reply', () => {
    useTaskStore.getState().upsert(task('one', 'COMPLETED'));
    useTaskStore.getState().upsert(task('one'));
    expect(useTaskStore.getState().tasks['one']?.state).toBe('COMPLETED');
  });
  it('allows recovery transitions when two events share a timestamp', () => {
    useTaskStore.getState().upsert(task('one', 'RECOVERABLE_INTERRUPTION'));
    useTaskStore.getState().upsert(task('one', 'RUNNING'));
    expect(useTaskStore.getState().tasks['one']?.state).toBe('RUNNING');
  });
  it('does not revive a terminal task with a same-millisecond stale running snapshot', () => {
    useTaskStore.getState().upsert(task('one', 'COMPLETED'));
    useTaskStore.getState().setTasks([task('one', 'RUNNING')]);
    expect(useTaskStore.getState().tasks['one']?.state).toBe('COMPLETED');
  });
  it('keeps the latest live phase when an older list shares its timestamp', () => {
    useTaskStore.getState().upsert(task('one', 'VERIFYING'));
    useTaskStore.getState().setTasks([task('one', 'RUNNING')]);
    expect(useTaskStore.getState().tasks['one']?.state).toBe('VERIFYING');
  });
  it('merges workspace snapshots and never selects another workspace task', () => {
    const store = useTaskStore.getState();
    store.upsert(task('other', 'RUNNING', 'workspace-b'));
    store.setTasks([task('own')]);
    expect(Object.keys(useTaskStore.getState().tasks)).toHaveLength(2);
    expect(tasksForWorkspace(useTaskStore.getState().tasks, 'workspace-a').map((item) => item.id)).toEqual(['own']);
    expect(tasksForWorkspace(useTaskStore.getState().tasks, null)).toEqual([]);
  });
  it('keeps explicit focus through updates and resets it when its task is removed', () => {
    const store = useTaskStore.getState();
    store.upsert(task('one'));
    store.focus('one');
    store.upsert(task('two'));
    expect(useTaskStore.getState().focusedTaskId).toBe('one');
    store.remove('one');
    expect(useTaskStore.getState().focusedTaskId).toBeNull();
  });
  it('removes every message in a deleted thread and leaves other threads', () => {
    const store = useTaskStore.getState();
    store.upsert({ ...task('root'), threadId: 'root' });
    store.upsert({ ...task('reply'), threadId: 'root' });
    store.upsert({ ...task('other'), threadId: 'other' });
    store.bumpDetails('reply');
    store.focus('reply');
    store.removeThread('root');
    expect(Object.keys(useTaskStore.getState().tasks)).toEqual(['other']);
    expect(useTaskStore.getState().focusedTaskId).toBeNull();
    expect(useTaskStore.getState().detailsRevision['reply']).toBeUndefined();
  });
  it('keeps blocked and interrupted tasks active and terminal tasks in history', () => {
    expect(isTerminalTask(task('blocked', 'BLOCKED'))).toBe(false);
    expect(isTerminalTask(task('interrupted', 'RECOVERABLE_INTERRUPTION'))).toBe(false);
    for (const state of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) expect(isTerminalTask(task(state, state))).toBe(true);
  });
});

describe('focused task selection', () => {
  it('honors explicit task selection while newer tasks arrive', async () => {
    const { pickFocusedTask } = await import('../../src/renderer/components/workspace/useFocusedTask');
    const older = task('older');
    const newer = { ...task('newer'), createdAt: '2026-10-25T03:01:00.000Z' };
    expect(pickFocusedTask({ older, newer }, 'older', 'workspace-a')?.id).toBe('older');
    expect(pickFocusedTask({ older, newer }, null, 'workspace-a')?.id).toBe('newer');
  });
  it('never leaks explicit focus or fallback tasks across workspaces', async () => {
    const { pickFocusedTask } = await import('../../src/renderer/components/workspace/useFocusedTask');
    const own = task('own');
    const other = task('other', 'RUNNING', 'workspace-b');
    expect(pickFocusedTask({ own, other }, 'other', 'workspace-a')?.id).toBe('own');
    expect(pickFocusedTask({ own, other }, 'other', null)).toBeNull();
    expect(pickFocusedTask({ other }, null, 'workspace-a')).toBeNull();
  });
});
