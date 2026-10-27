import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliEnvironment } from '@main/adapters/local-cli-adapter';
import { SqliteStore } from '@main/db/store';
import { QuotaPollingService } from '@main/usage/quota-polling';
import { QuotaRecorder } from '@main/usage/quota';

type Json = Record<string, unknown>;

class FakeCodexChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly requests: Json[] = [];
  readonly signals: string[] = [];
  pid: number | undefined = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private input = '';

  constructor(private readonly rateLimits?: unknown) {
    super();
    this.stdin.on('data', (chunk) => {
      this.input += String(chunk);
      for (;;) {
        const newline = this.input.indexOf('\n');
        if (newline < 0) break;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (line.trim() === '') continue;
        const message = JSON.parse(line) as Json;
        this.requests.push(message);
        if (message['method'] === 'initialize') {
          this.send({ id: message['id'], result: { userAgent: 'fixture' } });
        }
        if (message['method'] === 'account/rateLimits/read' && this.rateLimits !== undefined) {
          this.send({ id: message['id'], result: this.rateLimits });
        }
      }
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    this.signalCode = typeof signal === 'string' ? signal : null;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, this.signalCode);
    return true;
  }

  private send(message: Json): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function fakeEnv(child?: FakeCodexChild | (() => FakeCodexChild), available = true): CliEnvironment {
  return {
    pathEntries: ['/usr/local/bin'],
    isExecutable: (candidate) => available && candidate === '/usr/local/bin/codex',
    spawn: () => (typeof child === 'function' ? child() : child) as unknown as ChildProcessWithoutNullStreams,
    isPidAlive: () => true,
  };
}

const stores: SqliteStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

async function storeWithQuota(): Promise<{ store: SqliteStore; quota: QuotaRecorder }> {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  await store.migrate();
  return { store, quota: new QuotaRecorder(store) };
}

function storedLimits(store: SqliteStore): Array<Record<string, unknown>> {
  return store.db.prepare(`SELECT adapter_id, window_kind, remaining_percent, used_percent, source
    FROM agent_usage_limits ORDER BY window_kind`).all() as Array<Record<string, unknown>>;
}

describe('QuotaPollingService Codex probe', () => {
  it('reads Codex session and weekly limits through app-server and records them', async () => {
    const { store, quota } = await storeWithQuota();
    const child = new FakeCodexChild({
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300 },
        secondary: { usedPercent: 95, windowDurationMins: 10_080 },
      },
    });
    const service = new QuotaPollingService({ quota, env: fakeEnv(child), timeoutMs: 1_000 });

    await service.refresh();

    expect(child.requests.map((request) => request['method'])).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);
    expect(storedLimits(store)).toEqual([
      { adapter_id: 'codex', window_kind: 'session', remaining_percent: 58, used_percent: 42, source: 'codex' },
      { adapter_id: 'codex', window_kind: 'weekly', remaining_percent: 5, used_percent: 95, source: 'codex' },
    ]);
    expect(child.signals).toContain('SIGTERM');
  });

  it('leaves stored limits unchanged when Codex is absent or returns malformed data', async () => {
    const { store, quota } = await storeWithQuota();
    quota.record({
      adapterId: 'codex',
      sample: { source: 'codex', windows: [{ kind: 'session', usedPercent: 25 }] },
    });
    const before = storedLimits(store);

    await new QuotaPollingService({ quota, env: fakeEnv(undefined, false) }).refresh();
    const malformed = new FakeCodexChild({ rateLimits: { primary: { usedPercent: 'unknown' } } });
    await new QuotaPollingService({ quota, env: fakeEnv(malformed), timeoutMs: 1_000 }).refresh();

    expect(storedLimits(store)).toEqual(before);
  });

  it('times out and terminates an unresponsive app-server', async () => {
    vi.useFakeTimers();
    const { quota } = await storeWithQuota();
    const child = new FakeCodexChild();
    const service = new QuotaPollingService({ quota, env: fakeEnv(child), timeoutMs: 250 });

    const refresh = service.refresh();
    await vi.advanceTimersByTimeAsync(250);
    await refresh;

    expect(child.signals).toContain('SIGTERM');
  });
});

describe('QuotaPollingService lifecycle', () => {
  it('refreshes immediately and every five minutes after start', async () => {
    vi.useFakeTimers();
    const { quota } = await storeWithQuota();
    const children: FakeCodexChild[] = [];
    const service = new QuotaPollingService({
      quota,
      env: fakeEnv(() => {
        const child = new FakeCodexChild({ rateLimits: { primary: { usedPercent: 10 } } });
        children.push(child);
        return child;
      }),
      timeoutMs: 1_000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(children).toHaveLength(2);

    service.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(children).toHaveLength(2);
  });

  it('deduplicates overlapping refresh calls', async () => {
    vi.useFakeTimers();
    const { quota } = await storeWithQuota();
    const children: FakeCodexChild[] = [];
    const service = new QuotaPollingService({
      quota,
      env: fakeEnv(() => {
        const child = new FakeCodexChild();
        children.push(child);
        return child;
      }),
      timeoutMs: 250,
    });

    const first = service.refresh();
    const second = service.refresh();
    expect(children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(250);
    await Promise.all([first, second]);
    expect(children).toHaveLength(1);
  });

  it('stop clears the schedule and terminates an active probe', async () => {
    vi.useFakeTimers();
    const { quota } = await storeWithQuota();
    const children: FakeCodexChild[] = [];
    const service = new QuotaPollingService({
      quota,
      env: fakeEnv(() => {
        const child = new FakeCodexChild();
        children.push(child);
        return child;
      }),
      timeoutMs: 60_000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1);

    service.stop();
    expect(children[0]?.signals).toContain('SIGTERM');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(children).toHaveLength(1);
  });
});
