import { describe, expect, it } from 'vitest';
import { FakeAdapter, makeFakeAdapter } from './fake-adapter';
import { validateAdapterContract } from '@main/registry/registry';
import type { AgentSession } from '@shared/adapter';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    taskId: 't1',
    adapterId: 'fake-adapter',
    status: 'live',
    resumable: false,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('FakeAdapter', () => {
  it('satisfies the full AgentAdapter contract', () => {
    expect(validateAdapterContract(makeFakeAdapter())).toEqual([]);
  });

  it('streams scripted events with monotonic sequence numbers', async () => {
    const adapter = makeFakeAdapter({
      script: {
        events: [
          { kind: 'stdout', data: 'one' },
          { kind: 'progress', data: { pct: 50 } },
          { kind: 'stdout', data: 'two' },
        ],
      },
    });
    const handle = await adapter.start({ args: [] });
    const seen: number[] = [];
    for await (const event of adapter.stream(handle)) {
      seen.push(event.sequence);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(adapter.calls.streamed).toBe(3);
  });

  it('resolves the scripted terminal result', async () => {
    const adapter = makeFakeAdapter({
      script: { result: { status: 'failed', exitCode: 2, error: 'boom' } },
    });
    const handle = await adapter.start({});
    const result = await adapter.await(handle);
    expect(result).toEqual({ status: 'failed', exitCode: 2, error: 'boom' });
  });

  it('returns scripted liveness answers in order then the default', async () => {
    const adapter = makeFakeAdapter({
      script: { liveness: [true, false], livenessDefault: false },
    });
    expect(await adapter.probeLiveness(session())).toBe(true);
    expect(await adapter.probeLiveness(session())).toBe(false);
    expect(await adapter.probeLiveness(session())).toBe(false);
    expect(adapter.calls.livenessProbes).toHaveLength(3);
  });

  it('injects a crash at the scripted lifecycle point', async () => {
    const adapter = makeFakeAdapter({
      script: { crashAt: 'await', crashMessage: 'kaboom' },
    });
    const handle = await adapter.start({});
    await expect(adapter.await(handle)).rejects.toThrow('kaboom');
  });

  it('injects a crash at start before producing a handle', async () => {
    const adapter = makeFakeAdapter({ script: { crashAt: 'start' } });
    await expect(adapter.start({})).rejects.toThrow(/injected crash/);
  });

  it('records cancellation delivery', async () => {
    const adapter = makeFakeAdapter();
    const handle = await adapter.start({});
    await adapter.cancel(handle);
    expect(adapter.calls.cancelled).toEqual([handle]);
  });

  it('carries placeholder tokens through start input unchanged', async () => {
    const adapter = new FakeAdapter();
    const input = { args: ['--token', '{{SECRET:api_key}}'] };
    await adapter.start(input);
    expect(adapter.calls.started[0]).toEqual(input);
  });

  it('resumes into a new handle preserving externalRef', async () => {
    const adapter = makeFakeAdapter({ script: { resumable: true } });
    const resumed = await adapter.resume(session({ externalRef: 'pid-42' }));
    expect(resumed.externalRef).toBe('pid-42');
    expect(resumed.resumable).toBe(true);
    expect(adapter.calls.resumed).toHaveLength(1);
  });
});
