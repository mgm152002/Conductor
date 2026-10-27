import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliEnvironment } from '@main/adapters/local-cli-adapter';
import { SqliteStore } from '@main/db/store';
import { QuotaPollingService, type QuotaFetch } from '@main/usage/quota-polling';
import { QuotaRecorder } from '@main/usage/quota';

type Json = Record<string, unknown>;

const NOW = new Date('2026-10-27T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

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

/** A short-lived CLI probe that writes its output and exits. */
class FakeCliChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly signals: string[] = [];
  pid: number | undefined = 9876;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(output: { stdout?: string; stderr?: string; code?: number | null; hang?: boolean } = {}) {
    super();
    if (output.hang === true) return;
    queueMicrotask(() => {
      if (output.stdout !== undefined) this.stdout.write(output.stdout);
      if (output.stderr !== undefined) this.stderr.write(output.stderr);
      this.stdout.end();
      this.stderr.end();
      this.exitCode = output.code === undefined ? 0 : output.code;
      this.emit('close', this.exitCode, null);
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
}

interface FakeBinaries {
  codex?: FakeCodexChild | (() => FakeCodexChild);
  agy?: FakeCliChild | (() => FakeCliChild);
  opencode?: FakeCliChild | (() => FakeCliChild);
}

function spawnChild<T>(entry: T | (() => T) | undefined, name: string): T {
  if (entry === undefined) throw new Error(`Unexpected ${name} spawn`);
  return typeof entry === 'function' ? (entry as () => T)() : entry;
}

function fakeMultiEnv(children: FakeBinaries, available = true): CliEnvironment {
  return {
    pathEntries: ['/usr/local/bin'],
    isExecutable: (candidate) => available && (
      candidate === '/usr/local/bin/codex' && children.codex !== undefined
      || candidate === '/usr/local/bin/agy' && children.agy !== undefined
      || candidate === '/usr/local/bin/opencode' && children.opencode !== undefined
    ),
    spawn: (executable) => {
      const name = executable.split('/').pop();
      if (name === 'codex') return spawnChild(children.codex, name) as unknown as ChildProcessWithoutNullStreams;
      if (name === 'agy') return spawnChild(children.agy, name) as unknown as ChildProcessWithoutNullStreams;
      if (name === 'opencode') return spawnChild(children.opencode, name) as unknown as ChildProcessWithoutNullStreams;
      throw new Error(`Unexpected spawn: ${executable}`);
    },
    isPidAlive: () => true,
  };
}

function fakeEnv(child?: FakeCodexChild | (() => FakeCodexChild), available = true): CliEnvironment {
  return fakeMultiEnv(child === undefined ? {} : { codex: child }, available);
}

const stores: SqliteStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function storeWithQuota(now: () => Date = () => new Date()): Promise<{ store: SqliteStore; quota: QuotaRecorder }> {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  await store.migrate();
  return { store, quota: new QuotaRecorder(store, now) };
}

function storedLimits(store: SqliteStore): Array<Record<string, unknown>> {
  return store.db.prepare(`SELECT adapter_id, window_kind, remaining_percent, used_percent, source, label
    FROM agent_usage_limits ORDER BY adapter_id, window_kind`).all() as Array<Record<string, unknown>>;
}

function response(body: unknown, status = 200): Awaited<ReturnType<QuotaFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function storedDailyWindows(store: SqliteStore): Array<Record<string, unknown>> {
  return store.db.prepare(`SELECT window_kind, remaining_percent, used_percent, resets_at, source, label, window_minutes
    FROM agent_usage_limits WHERE adapter_id = 'opencode' AND window_kind = 'daily'`)
    .all() as Array<Record<string, unknown>>;
}

interface OpenCodeDbSeed {
  freeModelUpdatedAt?: number;
  freeModelId?: string;
  freeModelProvider?: string;
  error?: { createdAt: number; completedAt?: number; retryAfterMs?: number };
}

/** Build the two OpenCode tables the free-tier probe reads. */
function openCodeDb(seed: OpenCodeDbSeed = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-opencode-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'opencode.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session_v2 (time_updated INTEGER NOT NULL, model TEXT);
      CREATE TABLE session_message (type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    if (seed.freeModelUpdatedAt !== undefined) {
      db.prepare('INSERT INTO session_v2 (time_updated, model) VALUES (?, ?)').run(
        seed.freeModelUpdatedAt,
        JSON.stringify({
          providerID: seed.freeModelProvider ?? 'opencode',
          id: seed.freeModelId ?? 'deepseek-v4.1-flash-free',
        }),
      );
    }
    if (seed.error !== undefined) {
      db.prepare('INSERT INTO session_message (type, time_created, data) VALUES (?, ?, ?)').run(
        'assistant',
        seed.error.createdAt,
        JSON.stringify({
          time: {
            created: seed.error.createdAt,
            completed: seed.error.completedAt ?? seed.error.createdAt,
          },
          error: {
            type: 'provider.free-limit',
            ...(seed.error.retryAfterMs !== undefined ? { retryAfterMs: seed.error.retryAfterMs } : {}),
            // Free text is never read; keep it here so the test proves that.
            message: 'Free usage limit reached',
          },
        }),
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function missingOpenCodeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-opencode-missing-'));
  tempDirs.push(dir);
  return join(dir, 'missing', 'opencode.db');
}

/** The free-tier probe only needs an OpenCode executable on PATH. */
function freeTierService(quota: QuotaRecorder, dbPath: string): QuotaPollingService {
  return new QuotaPollingService({
    quota,
    env: fakeMultiEnv({ opencode: new FakeCliChild({ stdout: '[]' }) }),
    openCodeApiKey: async () => undefined,
    openCodeDbPath: dbPath,
    timeoutMs: 1_000,
    now: () => NOW,
  });
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
      { adapter_id: 'codex', window_kind: 'session', remaining_percent: 58, used_percent: 42, source: 'codex', label: null },
      { adapter_id: 'codex', window_kind: 'weekly', remaining_percent: 5, used_percent: 95, source: 'codex', label: null },
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

describe('QuotaPollingService CLI probes', () => {
  it('reads Antigravity weekly limits and keeps the most constrained model group', async () => {
    const { store, quota } = await storeWithQuota(() => NOW);
    const agy = new FakeCliChild({
      stdout: JSON.stringify({
        status: 'SUCCESS',
        command: {
          name: 'usage',
          data: {
            groups: [
              {
                name: 'Gemini Models',
                buckets: [{ window: 'weekly', remaining_fraction: 0.55, reset_time: at(5 * DAY) }],
              },
              {
                name: 'Claude and GPT models',
                buckets: [{ window: 'weekly', remaining_fraction: 0.1, reset_time: at(6 * DAY) }],
              },
            ],
          },
        },
      }),
    });
    const env = fakeMultiEnv({ agy });
    const spawn = vi.spyOn(env, 'spawn');
    const service = new QuotaPollingService({ quota, env, timeoutMs: 1_000, now: () => NOW });

    await service.refresh();

    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/agy', ['-p', '/usage', '--output-format', 'json']);
    expect(storedLimits(store)).toEqual([{
      adapter_id: 'antigravity',
      window_kind: 'weekly',
      remaining_percent: 10,
      used_percent: 90,
      source: 'antigravity',
      label: 'Claude and GPT models',
    }]);
  });

  it('reads OpenCode Go limits with the key from auth export', async () => {
    const { store, quota } = await storeWithQuota(() => NOW);
    const auth = new FakeCliChild({
      stdout: JSON.stringify([
        { integrationID: 'other', value: { type: 'key', key: 'not-this-key' } },
        { integrationID: 'opencode-go', active: false, value: { type: 'key', key: 'inactive-key' } },
        { integrationID: 'opencode-go', active: true, value: { type: 'key', key: 'oc_sk_test_key' } },
      ]),
    });
    const env = fakeMultiEnv({ opencode: auth });
    const spawn = vi.spyOn(env, 'spawn');
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: QuotaFetch = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return response({
        usage: {
          rolling: { status: 'ok', percent: 1, resetsAt: at(HOUR) },
          weekly: { status: 'ok', percent: 25, resetsAt: at(5 * DAY) },
          monthly: { status: 'ok', percent: 80, resetsAt: at(20 * DAY) },
        },
      });
    };
    const service = new QuotaPollingService({
      quota, env, fetch: fetchImpl, openCodeDbPath: null, timeoutMs: 1_000, now: () => NOW,
    });

    await service.refresh();

    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/opencode', ['auth', 'export']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer oc_sk_test_key');
    expect(storedLimits(store)).toEqual([
      { adapter_id: 'opencode', window_kind: 'session', remaining_percent: 99, used_percent: 1, source: 'opencode', label: null },
      { adapter_id: 'opencode', window_kind: 'weekly', remaining_percent: 75, used_percent: 25, source: 'opencode', label: null },
    ]);
  });

  it('leaves stored limits unchanged when the Go subscription is missing', async () => {
    const { store, quota } = await storeWithQuota(() => NOW);
    quota.record({
      adapterId: 'opencode',
      sample: { windows: [{ kind: 'session', usedPercent: 20, resetsAt: at(HOUR) }] },
    });
    const before = storedLimits(store);
    const service = new QuotaPollingService({
      quota,
      env: fakeMultiEnv({}),
      openCodeApiKey: async () => 'oc_sk_test_key',
      fetch: async () => response({ error: 'OpenCode Go subscription required.' }, 403),
      timeoutMs: 1_000,
      now: () => NOW,
    });

    await service.refresh();

    expect(storedLimits(store)).toEqual(before);
  });

  it('does not fetch when no OpenCode Go credential is configured', async () => {
    const { store, quota } = await storeWithQuota(() => NOW);
    const auth = new FakeCliChild({ stdout: JSON.stringify([{ integrationID: 'opencode', value: { type: 'key', key: 'other' } }]) });
    const fetchImpl = vi.fn<QuotaFetch>();
    const service = new QuotaPollingService({
      quota, env: fakeMultiEnv({ opencode: auth }), fetch: fetchImpl, openCodeDbPath: null, timeoutMs: 1_000, now: () => NOW,
    });

    await service.refresh();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storedLimits(store)).toEqual([]);
  });

  it('terminates an unresponsive CLI probe at the timeout', async () => {
    vi.useFakeTimers();
    const { quota } = await storeWithQuota(() => NOW);
    const agy = new FakeCliChild({ hang: true });
    const service = new QuotaPollingService({
      quota, env: fakeMultiEnv({ agy }), timeoutMs: 250, now: () => NOW,
    });

    const refresh = service.refresh();
    await vi.advanceTimersByTimeAsync(250);
    await refresh;

    expect(agy.signals).toContain('SIGTERM');
  });
});

describe('QuotaPollingService OpenCode free-tier probe', () => {
  it.each(['deepseek-v4.1-flash-free', 'big-pickle'])(
    'records an unreported daily window from recent %s usage',
    async (freeModelId) => {
      const { store, quota } = await storeWithQuota(() => NOW);
      const dbPath = openCodeDb({ freeModelUpdatedAt: NOW.getTime() - HOUR, freeModelId });

      await freeTierService(quota, dbPath).refresh();

      expect(storedDailyWindows(store)).toEqual([{
        window_kind: 'daily',
        remaining_percent: null,
        used_percent: null,
        resets_at: '2026-10-28T00:00:00.000Z',
        source: 'opencode',
        label: 'Free models',
        window_minutes: 1440,
      }]);
    },
  );

  it('records an observed block as exhausted until its retry time', async () => {
    const { store, quota } = await storeWithQuota(() => NOW);
    const blockedUntil = NOW.getTime() + 4 * HOUR;
    const completedAt = blockedUntil - 6 * HOUR;
    const dbPath = openCodeDb({
      freeModelUpdatedAt: completedAt,
      error: { createdAt: completedAt, completedAt, retryAfterMs: 6 * HOUR },
    });

    await freeTierService(quota, dbPath).refresh();

    expect(storedDailyWindows(store)).toEqual([{
      window_kind: 'daily',
      remaining_percent: 0,
      used_percent: 100,
      resets_at: new Date(blockedUntil).toISOString(),
      source: 'opencode',
      label: 'Free models',
      window_minutes: 1440,
    }]);
  });

  it('does not keep reporting exhaustion after the retry time has elapsed', async () => {
    const { store, quota } = await storeWithQuota(() => NOW);
    const completedAt = NOW.getTime() - 10 * HOUR;
    const dbPath = openCodeDb({
      freeModelUpdatedAt: NOW.getTime() - HOUR,
      error: { createdAt: completedAt, completedAt, retryAfterMs: HOUR },
    });

    await freeTierService(quota, dbPath).refresh();

    expect(storedDailyWindows(store)).toMatchObject([{
      window_kind: 'daily',
      remaining_percent: null,
      used_percent: null,
      resets_at: '2026-10-28T00:00:00.000Z',
    }]);
  });

  it('ignores old free usage, paid models, and missing databases', async () => {
    const { store, quota } = await storeWithQuota(() => NOW);

    await freeTierService(quota, openCodeDb({ freeModelUpdatedAt: NOW.getTime() - 2 * DAY })).refresh();
    await freeTierService(quota, openCodeDb({
      freeModelUpdatedAt: NOW.getTime() - HOUR,
      freeModelProvider: 'opencode-go',
      freeModelId: 'deepseek-v4.1-flash',
    })).refresh();
    await freeTierService(quota, missingOpenCodeDb()).refresh();

    expect(storedDailyWindows(store)).toEqual([]);
  });

  it('does not read the database without an OpenCode CLI', async () => {
    const { store, quota } = await storeWithQuota(() => NOW);
    const service = new QuotaPollingService({
      quota,
      env: fakeMultiEnv({}),
      openCodeDbPath: openCodeDb({ freeModelUpdatedAt: NOW.getTime() - HOUR }),
      timeoutMs: 1_000,
      now: () => NOW,
    });

    await service.refresh();

    expect(storedDailyWindows(store)).toEqual([]);
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

  it('stop terminates every concurrently running CLI probe', async () => {
    vi.useFakeTimers();
    const { quota } = await storeWithQuota();
    const codex = new FakeCodexChild();
    const agy = new FakeCliChild({ hang: true });
    const auth = new FakeCliChild({ hang: true });
    const service = new QuotaPollingService({
      quota,
      env: fakeMultiEnv({ codex: () => codex, agy, opencode: auth }),
      openCodeDbPath: null,
      timeoutMs: 60_000,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.stop();

    expect(codex.signals).toContain('SIGTERM');
    expect(agy.signals).toContain('SIGTERM');
    expect(auth.signals).toContain('SIGTERM');
  });
});
