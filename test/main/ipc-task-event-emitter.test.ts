import { describe, expect, it } from 'vitest';
import { IpcTaskEventEmitter } from '@main/ipc/task-event-emitter';

describe('IpcTaskEventEmitter listeners', () => {
  it('tells in-process listeners about every event, with no window open, and survives a failing listener', () => {
    const emitter = new IpcTaskEventEmitter({ emit: () => { throw new Error('no window'); } } as never);
    const seen: string[] = [];
    emitter.subscribe(() => { throw new Error('bad listener'); });
    const stop = emitter.subscribe((channel, payload) => { seen.push(`${channel}:${(payload as { id: string }).id}`); });
    emitter.emit('task.updated', { id: 't1' });
    stop();
    emitter.emit('task.updated', { id: 't2' });
    expect(seen).toEqual(['task.updated:t1']);
  });
});
