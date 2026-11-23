import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDetails } from '../../src/shared/task-view';
import { cachedTaskDetails, loadTaskDetails, resetTaskDetailsCache } from '../../src/renderer/hooks/useTaskDetails';
import { useTaskStore } from '../../src/renderer/stores/task-store';
import { isLowPowerMachine, resolveEffects } from '../../src/renderer/stores/theme-store';

const details = (id: string, n: number): TaskDetails => ({ task: { id }, n } as unknown as TaskDetails);

describe('shared task-details loader', () => {
  let calls: number;
  beforeEach(() => {
    calls = 0;
    resetTaskDetailsCache();
    vi.stubGlobal('window', { conductor: { task: { details: (id: string) => { calls += 1; return Promise.resolve(details(id, calls)); } } } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shares one request between callers asking for the same version', async () => {
    const [a, b, c] = await Promise.all([loadTaskDetails('t', 'v1', false), loadTaskDetails('t', 'v1', false), loadTaskDetails('t', 'v1', false)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('fetches again for a new version, or when forced', async () => {
    await loadTaskDetails('t', 'v1', false);
    await loadTaskDetails('t', 'v2', false);
    await loadTaskDetails('t', 'v2', true);
    expect(calls).toBe(3);
  });

  it('keeps the last result so a reopened thread paints at once', async () => {
    expect(cachedTaskDetails('t')).toBeUndefined();
    const loaded = await loadTaskDetails('t', 'v1', false);
    expect(cachedTaskDetails('t')).toBe(loaded);
  });

  it('retries after a failed request instead of caching the failure', async () => {
    vi.stubGlobal('window', { conductor: { task: { details: () => { calls += 1; return Promise.reject(new Error('offline')); } } } });
    await expect(loadTaskDetails('t', 'v1', false)).rejects.toThrow('offline');
    await expect(loadTaskDetails('t', 'v1', false)).rejects.toThrow('offline');
    expect(calls).toBe(2);
  });
});

describe('batched detail bumps', () => {
  beforeEach(() => useTaskStore.getState().clear());
  it('bumps several tasks in one store update', () => {
    let updates = 0;
    const stop = useTaskStore.subscribe(() => { updates += 1; });
    useTaskStore.getState().bumpDetailsMany(['a', 'b', 'a']);
    stop();
    expect(updates).toBe(1);
    expect(useTaskStore.getState().detailsRevision).toMatchObject({ a: 2, b: 1 });
  });
  it('does nothing for an empty batch', () => {
    const before = useTaskStore.getState();
    useTaskStore.getState().bumpDetailsMany([]);
    expect(useTaskStore.getState()).toBe(before);
  });
});

describe('reduced effects', () => {
  it('treats few cores or little memory as low-power', () => {
    expect(isLowPowerMachine({ hardwareConcurrency: 4 })).toBe(true);
    expect(isLowPowerMachine({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(true);
    expect(isLowPowerMachine({ hardwareConcurrency: 10, deviceMemory: 8 })).toBe(false);
    expect(isLowPowerMachine({})).toBe(false);
  });
  it('honours an explicit choice over detection', () => {
    expect(resolveEffects('auto', true)).toBe(true);
    expect(resolveEffects('auto', false)).toBe(false);
    expect(resolveEffects('full', true)).toBe(false);
    expect(resolveEffects('reduced', false)).toBe(true);
  });
});
