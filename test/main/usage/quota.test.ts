import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import {
  isQuotaWindowCurrent,
  nextUtcMidnight,
  normalizeQuotaSample,
  quotaFromEvent,
  quotaSampleFromAntigravityUsage,
  quotaSampleFromCodexRateLimits,
  quotaSampleFromOpenCodeFreeTier,
  quotaSampleFromOpenCodeGoUsage,
  QuotaRecorder,
} from '@main/usage/quota';
import type { AdapterStreamEvent } from '@shared/adapter';

// Quota normalization and persistence: Codex primary/secondary mapping,
// malformed percentages, stale reset windows, and the latest-snapshot upsert.
// Everything runs against a migrated in-memory SQLite store; no CLI is called.

const NOW = new Date('2026-10-27T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function freshStore(): Promise<SqliteStore> {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  await store.migrate();
  return store;
}

const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const epochSeconds = (offsetMs: number): number => Math.floor((NOW.getTime() + offsetMs) / 1000);

function event(data: unknown, kind: AdapterStreamEvent['kind'] = 'log'): AdapterStreamEvent {
  return { kind, sequence: 1, data, at: NOW.toISOString() };
}

describe('Codex rate-limit mapping', () => {
  it('maps primary to the session window and secondary to the weekly window', () => {
    const sample = quotaSampleFromCodexRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 12, resetsAt: at(HOUR), windowDurationMins: 300 },
          secondary: { usedPercent: 88, resetsAt: at(5 * DAY), windowDurationMins: 10_080 },
        },
      },
      { now: NOW, source: 'codex' },
    );

    expect(sample).toEqual({
      source: 'codex',
      windows: [
        { kind: 'session', usedPercent: 12, remainingPercent: 88, resetsAt: at(HOUR), windowMinutes: 300 },
        { kind: 'weekly', usedPercent: 88, remainingPercent: 12, resetsAt: at(5 * DAY), windowMinutes: 10_080 },
      ],
    });
  });

  it('accepts snake_case fields from older app-server builds and a direct params payload', () => {
    const sample = quotaSampleFromCodexRateLimits(
      {
        primary: {
          used_percent: 0,
          resets_at: epochSeconds(HOUR),
          window_minutes: 60,
        },
        secondary: {
          remaining_percent: 100,
          resets_at: epochSeconds(7 * DAY),
        },
      },
      { now: NOW, source: 'codex' },
    );

    expect(sample?.windows).toEqual([
      { kind: 'session', usedPercent: 0, remainingPercent: 100, resetsAt: at(HOUR), windowMinutes: 60 },
      { kind: 'weekly', usedPercent: 0, remainingPercent: 100, resetsAt: at(7 * DAY) },
    ]);
  });

  it('keeps only the windows Codex actually reported', () => {
    const sample = quotaSampleFromCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 50, resetsAt: at(HOUR) } } },
      { now: NOW },
    );

    expect(sample?.windows).toEqual([{ kind: 'session', usedPercent: 50, remainingPercent: 50, resetsAt: at(HOUR) }]);
    expect(sample?.source).toBeUndefined();
  });

  it('returns undefined when neither window is usable', () => {
    expect(quotaSampleFromCodexRateLimits(undefined, { now: NOW })).toBeUndefined();
    expect(quotaSampleFromCodexRateLimits({ rateLimits: {} }, { now: NOW })).toBeUndefined();
    expect(quotaSampleFromCodexRateLimits({ rateLimits: { primary: null, secondary: 'nope' } }, { now: NOW })).toBeUndefined();
  });
});

describe('Antigravity usage mapping', () => {
  it('maps model groups to labelled windows and keeps the most constrained group', () => {
    const sample = quotaSampleFromAntigravityUsage(
      {
        command: {
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
      },
      { now: NOW },
    );

    expect(sample).toEqual({
      source: 'antigravity',
      windows: [{
        kind: 'weekly',
        remainingPercent: 10,
        usedPercent: 90,
        resetsAt: at(6 * DAY),
        label: 'Claude and GPT models',
      }],
    });
  });

  it('uses the earlier reset when groups report the same remaining percentage', () => {
    const sample = quotaSampleFromAntigravityUsage(
      {
        command: {
          data: {
            groups: [
              {
                name: 'Gemini Models',
                buckets: [{ window: 'weekly', remaining_fraction: 0, reset_time: at(5 * DAY) }],
              },
              {
                name: 'Claude and GPT models',
                buckets: [{ window: 'weekly', remaining_fraction: 0, reset_time: at(6 * DAY) }],
              },
            ],
          },
        },
      },
      { now: NOW },
    );

    expect(sample?.windows).toEqual([{
      kind: 'weekly',
      remainingPercent: 0,
      usedPercent: 100,
      resetsAt: at(5 * DAY),
      label: 'Gemini Models',
    }]);
  });

  it('ignores unsupported windows and unusable fractions', () => {
    expect(quotaSampleFromAntigravityUsage(undefined, { now: NOW })).toBeUndefined();
    expect(quotaSampleFromAntigravityUsage(
      {
        command: {
          data: {
            groups: [
              { name: 'Daily', buckets: [{ window: 'daily', remaining_fraction: 0.5 }] },
              { name: 'Broken', buckets: [{ window: 'weekly', remaining_fraction: 1.5 }] },
            ],
          },
        },
      },
      { now: NOW },
    )).toBeUndefined();
  });
});

describe('OpenCode Go usage mapping', () => {
  it('maps rolling to session and weekly to weekly while ignoring monthly', () => {
    const sample = quotaSampleFromOpenCodeGoUsage(
      {
        usage: {
          rolling: { status: 'ok', percent: 1, resetsAt: at(HOUR) },
          weekly: { status: 'ok', percent: 25, resetsAt: at(5 * DAY) },
          monthly: { status: 'ok', percent: 80, resetsAt: at(20 * DAY) },
        },
      },
      { now: NOW },
    );

    expect(sample).toEqual({
      source: 'opencode',
      windows: [
        { kind: 'session', usedPercent: 1, remainingPercent: 99, resetsAt: at(HOUR) },
        { kind: 'weekly', usedPercent: 25, remainingPercent: 75, resetsAt: at(5 * DAY) },
      ],
    });
  });

  it('drops invalid percentages and payloads without usage', () => {
    expect(quotaSampleFromOpenCodeGoUsage(undefined, { now: NOW })).toBeUndefined();
    expect(quotaSampleFromOpenCodeGoUsage({ usage: {} }, { now: NOW })).toBeUndefined();
    expect(quotaSampleFromOpenCodeGoUsage(
      {
        usage: {
          rolling: { percent: 150 },
          weekly: { percent: '25' },
        },
      },
      { now: NOW },
    )).toBeUndefined();
  });
});

describe('OpenCode free-tier mapping', () => {
  it('maps recent free-model usage to an unreported daily window with the next UTC midnight', () => {
    const sample = quotaSampleFromOpenCodeFreeTier({ freeModelsUsed: true }, { now: NOW });

    expect(sample).toEqual({
      source: 'opencode',
      windows: [{
        kind: 'daily',
        resetsAt: '2026-10-28T00:00:00.000Z',
        windowMinutes: 1440,
        label: 'Free models',
      }],
    });
    // A daily window without a reported percentage must not invent one.
    expect(sample?.windows[0]?.usedPercent).toBeUndefined();
    expect(sample?.windows[0]?.remainingPercent).toBeUndefined();
  });

  it('reports an observed block as fully consumed until its retry time', () => {
    const blockedUntil = at(6 * HOUR);
    const sample = quotaSampleFromOpenCodeFreeTier(
      { freeModelsUsed: true, blockedUntil },
      { now: NOW },
    );

    expect(sample?.windows).toEqual([{
      kind: 'daily',
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: blockedUntil,
      windowMinutes: 1440,
      label: 'Free models',
    }]);
  });

  it('requires recent free-model usage or a current block', () => {
    expect(quotaSampleFromOpenCodeFreeTier({}, { now: NOW })).toBeUndefined();
    expect(quotaSampleFromOpenCodeFreeTier(
      { freeModelsUsed: false, blockedUntil: at(-HOUR) },
      { now: NOW },
    )).toBeUndefined();
    expect(quotaSampleFromOpenCodeFreeTier({ blockedUntil: 'not a date' }, { now: NOW })).toBeUndefined();
  });

  it('treats an elapsed retry time as unblocked and keeps the daily window', () => {
    const sample = quotaSampleFromOpenCodeFreeTier(
      { freeModelsUsed: true, blockedUntil: at(-HOUR) },
      { now: NOW },
    );

    expect(sample?.windows[0]).toMatchObject({
      kind: 'daily',
      resetsAt: '2026-10-28T00:00:00.000Z',
    });
    expect(sample?.windows[0]?.usedPercent).toBeUndefined();
    expect(sample?.windows[0]?.remainingPercent).toBeUndefined();
  });

  it('resets at midnight UTC across a month and year boundary', () => {
    expect(nextUtcMidnight(NOW).toISOString()).toBe('2026-10-28T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-12-31T23:59:59.999Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('percentage validation', () => {
  it.each([
    ['negative used percent', { kind: 'session', usedPercent: -1 }],
    ['used percent above 100', { kind: 'session', usedPercent: 101 }],
    ['numeric string', { kind: 'session', usedPercent: '50' }],
    ['NaN remaining percent', { kind: 'session', remainingPercent: Number.NaN }],
    ['infinite remaining percent', { kind: 'session', remainingPercent: Number.POSITIVE_INFINITY }],
    ['no percentage at all', { kind: 'session' }],
    ['unknown window kind', { kind: 'monthly', usedPercent: 10 }],
    ['negative duration', { kind: 'session', usedPercent: 10, windowMinutes: -5 }],
    ['non-numeric duration', { kind: 'session', usedPercent: 10, windowMinutes: '300' }],
  ])('drops a window with a %s', (_label, window) => {
    expect(normalizeQuotaSample({ windows: [window] }, { now: NOW })).toBeUndefined();
  });

  it('keeps valid windows and drops malformed siblings', () => {
    const sample = normalizeQuotaSample(
      {
        source: 'claude-code',
        windows: [
          { kind: 'session', usedPercent: 150, resetsAt: at(HOUR) },
          { kind: 'weekly', remainingPercent: 42, resetsAt: at(3 * DAY) },
        ],
      },
      { now: NOW },
    );

    expect(sample).toEqual({
      source: 'claude-code',
      windows: [{ kind: 'weekly', remainingPercent: 42, usedPercent: 58, resetsAt: at(3 * DAY) }],
    });
  });

  it('never invents a percentage from a missing one and keeps a reported zero', () => {
    expect(normalizeQuotaSample({ windows: [{ kind: 'session', usedPercent: 0 }] }, { now: NOW })).toEqual({
      windows: [{ kind: 'session', usedPercent: 0, remainingPercent: 100 }],
    });
    expect(normalizeQuotaSample({ windows: [{ kind: 'session', remainingPercent: 0 }] }, { now: NOW })).toEqual({
      windows: [{ kind: 'session', remainingPercent: 0, usedPercent: 100 }],
    });
  });

  it('keeps a known daily window that reports a reset but no percentage', () => {
    expect(normalizeQuotaSample(
      { windows: [{ kind: 'daily', resetsAt: at(DAY), label: 'Free models' }] },
      { now: NOW },
    )).toEqual({
      windows: [{ kind: 'daily', resetsAt: at(DAY), label: 'Free models' }],
    });
  });

  it('ignores an unusable source instead of persisting it', () => {
    const sample = normalizeQuotaSample(
      { source: 'not a source!', windows: [{ kind: 'session', usedPercent: 5 }] },
      { now: NOW },
    );
    expect(sample?.source).toBeUndefined();
  });

  it('keeps the most constrained window when a kind is reported twice', () => {
    const sample = normalizeQuotaSample(
      {
        windows: [
          { kind: 'weekly', remainingPercent: 40, resetsAt: at(5 * DAY), label: 'Group A' },
          { kind: 'weekly', remainingPercent: 10, resetsAt: at(6 * DAY), label: 'Group B' },
        ],
      },
      { now: NOW },
    );

    expect(sample?.windows).toEqual([
      { kind: 'weekly', remainingPercent: 10, usedPercent: 90, resetsAt: at(6 * DAY), label: 'Group B' },
    ]);
  });

  it('trims a usable window label and drops an unusable one', () => {
    const labelled = normalizeQuotaSample(
      { windows: [{ kind: 'weekly', remainingPercent: 10, label: '  Gemini   Models  ' }] },
      { now: NOW },
    );
    const tooLong = normalizeQuotaSample(
      { windows: [{ kind: 'weekly', remainingPercent: 10, label: 'x'.repeat(61) }] },
      { now: NOW },
    );

    expect(labelled?.windows[0]?.label).toBe('Gemini Models');
    expect(tooLong?.windows[0]?.label).toBeUndefined();
  });
});

describe('reset windows', () => {
  it.each([
    ['an ISO reset in the past', at(-1)],
    ['an epoch-seconds reset in the past', epochSeconds(-1)],
    ['an unparseable ISO prefix', '2026-99-99T99:99:99.000Z'],
    ['a non-ISO string', 'in one hour'],
    ['epoch zero', 0],
    ['a negative epoch', -1],
  ])('rejects %s', (_label, resetsAt) => {
    expect(normalizeQuotaSample({ windows: [{ kind: 'session', usedPercent: 10, resetsAt }] }, { now: NOW })).toBeUndefined();
  });

  it('keeps a reset exactly in the future', () => {
    const sample = normalizeQuotaSample(
      { windows: [{ kind: 'weekly', usedPercent: 10, resetsAt: at(MINUTE) }] },
      { now: NOW },
    );
    expect(sample?.windows[0]?.resetsAt).toBe(at(MINUTE));
  });

  it('reports whether a stored window is still current', () => {
    expect(isQuotaWindowCurrent({}, NOW)).toBe(true);
    expect(isQuotaWindowCurrent({ resetsAt: at(MINUTE) }, NOW)).toBe(true);
    expect(isQuotaWindowCurrent({ resetsAt: at(-1) }, NOW)).toBe(false);
    expect(isQuotaWindowCurrent({ resetsAt: 'not a date' }, NOW)).toBe(false);
  });
});

describe('quota stream events', () => {
  it('reads a quota payload from a log event only', () => {
    const data = { quota: { source: 'codex', windows: [{ kind: 'session', usedPercent: 25, resetsAt: at(HOUR) }] } };

    expect(quotaFromEvent(event(data))).toEqual({
      source: 'codex',
      windows: [{ kind: 'session', usedPercent: 25, remainingPercent: 75, resetsAt: at(HOUR) }],
    });
    expect(quotaFromEvent(event(data, 'stdout'))).toBeUndefined();
    expect(quotaFromEvent(event({ usage: { totalTokens: 10 } }))).toBeUndefined();
  });
});

interface LimitRow {
  adapter_id: string;
  window_kind: string;
  label: string | null;
  remaining_percent: number | null;
  used_percent: number | null;
  resets_at: string | null;
  reported_at: string;
  source: string | null;
  window_minutes: number | null;
}

function limitRows(store: SqliteStore): LimitRow[] {
  return store.db
    .prepare(`SELECT adapter_id, window_kind, label, remaining_percent, used_percent, resets_at, reported_at, source, window_minutes
      FROM agent_usage_limits ORDER BY adapter_id, window_kind`)
    .all() as LimitRow[];
}

describe('QuotaRecorder latest-snapshot upsert', () => {
  it('upserts one row per adapter and window, keeping the latest snapshot', async () => {
    const store = await freshStore();
    let now = NOW;
    const recorder = new QuotaRecorder(store, () => now);

    recorder.record({
      adapterId: 'codex',
      sample: {
        windows: [
          { kind: 'session', usedPercent: 10, resetsAt: at(HOUR), windowMinutes: 300, label: 'Primary' },
          { kind: 'weekly', remainingPercent: 90, resetsAt: at(5 * DAY), windowMinutes: 10_080, label: 'Gemini Models' },
        ],
      },
    });

    now = new Date(NOW.getTime() + MINUTE);
    recorder.record({
      adapterId: 'codex',
      sample: { windows: [{ kind: 'session', usedPercent: 25, resetsAt: at(HOUR) }] },
    });

    const rows = limitRows(store);
    expect(rows).toHaveLength(2);
    const session = rows.find((row) => row.window_kind === 'session')!;
    const weekly = rows.find((row) => row.window_kind === 'weekly')!;

    // The newer session sample replaced the old one in place.
    expect(session).toMatchObject({
      adapter_id: 'codex',
      remaining_percent: 75,
      used_percent: 25,
      resets_at: at(HOUR),
      reported_at: now.toISOString(),
      source: 'codex',
      // A sample without a duration or label does not resurrect the old ones.
      window_minutes: null,
      label: null,
    });
    // A sample that omits the weekly window leaves the prior snapshot alone.
    expect(weekly).toMatchObject({
      remaining_percent: 90,
      used_percent: 10,
      resets_at: at(5 * DAY),
      reported_at: NOW.toISOString(),
      window_minutes: 10_080,
      label: 'Gemini Models',
    });

    // A third snapshot for the same window still upserts rather than inserts.
    now = new Date(NOW.getTime() + 2 * MINUTE);
    recorder.record({
      adapterId: 'codex',
      sample: { windows: [{ kind: 'session', remainingPercent: 5, resetsAt: at(2 * HOUR) }] },
    });

    const after = limitRows(store);
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.window_kind === 'session')).toMatchObject({
      remaining_percent: 5,
      used_percent: 95,
      resets_at: at(2 * HOUR),
      reported_at: now.toISOString(),
    });
  });

  it('writes malformed and stale windows nowhere', async () => {
    const store = await freshStore();
    const recorder = new QuotaRecorder(store, () => NOW);

    recorder.record({
      adapterId: 'codex',
      sample: { windows: [{ kind: 'session', usedPercent: 101, resetsAt: at(HOUR) }] },
    });
    recorder.record({
      adapterId: 'codex',
      sample: { windows: [{ kind: 'weekly', usedPercent: 10, resetsAt: at(-HOUR) }] },
    });
    recorder.record({
      adapterId: 'not a valid id!',
      sample: { windows: [{ kind: 'session', usedPercent: 10, resetsAt: at(HOUR) }] },
    });
    recorder.record({ adapterId: 'codex', sample: null });

    expect(limitRows(store)).toEqual([]);
  });

  it('keeps adapters and window kinds independent', async () => {
    const store = await freshStore();
    const recorder = new QuotaRecorder(store, () => NOW);

    recorder.record({
      adapterId: 'codex',
      sample: { windows: [{ kind: 'session', usedPercent: 10, resetsAt: at(HOUR) }] },
    });
    recorder.record({
      adapterId: 'claude-code',
      sample: { windows: [{ kind: 'session', usedPercent: 40, resetsAt: at(2 * HOUR) }] },
    });

    expect(limitRows(store).map((row) => [row.adapter_id, row.window_kind, row.used_percent])).toEqual([
      ['claude-code', 'session', 40],
      ['codex', 'session', 10],
    ]);
  });
});
