import type { AdapterStreamEvent } from '@shared/adapter';
import type { UsageLimitWindow, UsageLimitWindowKind } from '@shared/usage';
import type { Store } from '../db/types';

// Quota and rate-limit windows reported by agent CLIs.
//
// Adapters report quota alongside token usage: a `log` stream event whose data
// is `{ quota: QuotaSample }`. The payload is deliberately generic so every
// adapter can report the same windows without teaching the recorder about its
// wire format:
//
//   { quota: { source?: 'codex', windows: [
//       { kind: 'session', usedPercent: 0, resetsAt: 1730000000, windowMinutes: 300 },
//       { kind: 'daily', resetsAt: '2026-11-01T00:00:00.000Z', label: 'Free models' },
//       { kind: 'weekly', remainingPercent: 88, resetsAt: '2026-11-01T12:00:00.000Z', label: 'Gemini Models' },
//   ] } }
//
// A window carries at least one of `usedPercent` / `remainingPercent`; the
// missing side is derived. `resetsAt` accepts an ISO string or Unix epoch
// seconds/milliseconds. Malformed percentages, timestamps, and durations
// reject the whole window rather than being clamped, and a window whose reset
// has already passed is not a current limit. Only these typed fields are ever
// persisted, so prompts, message text, or secrets can never reach the table.
//
// The recorder upserts the latest snapshot per (adapter, window kind); older
// samples for the same window are overwritten. When one snapshot contains the
// same kind twice, the most constrained window wins because the table has no
// room for both.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);

export const QUOTA_WINDOW_KINDS: readonly UsageLimitWindowKind[] = ['session', 'daily', 'weekly'];

/** One window in a generic quota log payload. */
export interface QuotaWindowSample {
  kind: UsageLimitWindowKind;
  /** Percentage already consumed in the window, 0–100. */
  usedPercent?: number;
  /** Percentage still available in the window, 0–100. */
  remainingPercent?: number;
  /** ISO 8601 string, or Unix epoch seconds/milliseconds. */
  resetsAt?: string | number;
  /** Total length of the window in minutes. */
  windowMinutes?: number;
  /** Optional provider label identifying the quota inside its window kind. */
  label?: string;
}

/** The generic quota log payload contract. */
export interface QuotaSample {
  /** Adapter id that produced the sample (e.g. `codex`). */
  source?: string;
  windows: QuotaWindowSample[];
}

/** A validated quota window with an ISO reset time. */
export interface NormalizedQuotaWindow {
  kind: UsageLimitWindowKind;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  windowMinutes?: number;
  label?: string;
}

/** A validated quota sample. */
export interface NormalizedQuotaSample {
  source?: string;
  windows: NormalizedQuotaWindow[];
}

const INVALID = 'invalid' as const;
const EXPIRED = 'expired' as const;
const SOURCE = /^[\w.:-]{1,64}$/;
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function safeSource(value: unknown): string | undefined {
  return typeof value === 'string' && SOURCE.test(value) ? value : undefined;
}

/** A short display label, `undefined` when absent or unusable. */
function safeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim().replace(/\s+/g, ' ');
  return label.length > 0 && label.length <= 60 && !CONTROL_CHARACTERS.test(label) ? label : undefined;
}

/** A finite 0–100 percentage, `undefined` when absent, or `INVALID`. */
function percentage(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return INVALID;
  return value;
}

/** A future ISO timestamp, `undefined` when absent, or INVALID/EXPIRED. */
function resetTime(value: unknown, now: Date): string | undefined | typeof INVALID | typeof EXPIRED {
  if (value === undefined || value === null) return undefined;
  let time: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return INVALID;
    // Codex reports epoch seconds; accept milliseconds from other adapters.
    time = value < 1e11 ? value * 1000 : value;
  } else if (typeof value === 'string' && value.length <= 64 && ISO_PREFIX.test(value)) {
    time = Date.parse(value);
  } else {
    return INVALID;
  }
  if (!Number.isFinite(time)) return INVALID;
  if (time <= now.getTime()) return EXPIRED;
  return new Date(time).toISOString();
}

/** A non-negative whole number of minutes, or INVALID. */
function durationMinutes(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID;
  return Math.round(value);
}

function normalizeWindow(value: unknown, now: Date): NormalizedQuotaWindow | undefined {
  const raw = obj(value);
  if (raw === null) return undefined;
  const kind = raw['kind'];
  if (kind !== 'session' && kind !== 'daily' && kind !== 'weekly') return undefined;

  const used = percentage(raw['usedPercent']);
  if (used === INVALID) return undefined;
  const remaining = percentage(raw['remainingPercent']);
  if (remaining === INVALID) return undefined;

  const resetsAt = resetTime(raw['resetsAt'], now);
  if (resetsAt === INVALID || resetsAt === EXPIRED) return undefined;

  // A window without a percentage is still useful when it has a reset time:
  // it says the quota exists but the CLI does not report how much is left.
  // Never invent a percentage for it.
  if (used === undefined && remaining === undefined && resetsAt === undefined) return undefined;

  const windowMinutes = durationMinutes(raw['windowMinutes']);
  if (windowMinutes === INVALID) return undefined;

  const label = safeLabel(raw['label']);

  return {
    kind,
    ...(used !== undefined ? { usedPercent: used } : remaining !== undefined ? { usedPercent: 100 - remaining } : {}),
    ...(remaining !== undefined ? { remainingPercent: remaining } : used !== undefined ? { remainingPercent: 100 - used } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Pick the window that better represents the remaining quota when a source
 * reports one kind twice: less remaining first, then the earlier reset. The
 * stored table has one row per kind, so this choice is deterministic rather
 * than depending on provider ordering.
 */
function mostConstrained(
  a: NormalizedQuotaWindow,
  b: NormalizedQuotaWindow,
): NormalizedQuotaWindow {
  const remainingA = a.remainingPercent ?? 100;
  const remainingB = b.remainingPercent ?? 100;
  if (remainingA !== remainingB) return remainingA < remainingB ? a : b;
  const resetA = a.resetsAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.resetsAt);
  const resetB = b.resetsAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.resetsAt);
  return resetB < resetA ? b : a;
}

/**
 * Validate and normalize a quota payload from any adapter. Returns `undefined`
 * when the payload has no usable window; malformed individual windows are
 * dropped, and an expired reset window is never returned as current.
 */
export function normalizeQuotaSample(
  value: unknown,
  options: { now?: Date; source?: string } = {},
): NormalizedQuotaSample | undefined {
  const raw = obj(value);
  if (raw === null) return undefined;
  const now = options.now ?? new Date();
  const source = safeSource(raw['source']) ?? safeSource(options.source);
  const windows = Array.isArray(raw['windows']) ? raw['windows'] : [];
  const byKind = new Map<UsageLimitWindowKind, NormalizedQuotaWindow>();
  for (const window of windows) {
    const normalized = normalizeWindow(window, now);
    if (normalized === undefined) continue;
    const prior = byKind.get(normalized.kind);
    byKind.set(normalized.kind, prior === undefined ? normalized : mostConstrained(prior, normalized));
  }
  if (byKind.size === 0) return undefined;
  return {
    ...(source !== undefined ? { source } : {}),
    windows: [...byKind.values()],
  };
}

/**
 * Map a Codex app-server rate-limit snapshot onto the generic contract:
 * `primary` is the Session window and `secondary` is the Weekly window.
 */
export function quotaSampleFromCodexRateLimits(
  value: unknown,
  options: { now?: Date; source?: string } = {},
): NormalizedQuotaSample | undefined {
  let raw = obj(value);
  if (raw === null) return undefined;
  // The snapshot arrives under `rateLimits` in `account/rateLimits/updated`
  // and directly under `params` in some older builds.
  for (const key of ['rateLimits', 'rate_limits']) {
    const nested = obj(raw[key]);
    if (nested !== null) { raw = nested; break; }
  }

  const windows: Json[] = [];
  const add = (key: 'primary' | 'secondary', kind: UsageLimitWindowKind): void => {
    const window = obj(raw[key]);
    if (window === null) return;
    windows.push({
      kind,
      usedPercent: window['usedPercent'] ?? window['used_percent'],
      remainingPercent: window['remainingPercent'] ?? window['remaining_percent'],
      resetsAt: window['resetsAt'] ?? window['resets_at'],
      windowMinutes: window['windowDurationMins'] ?? window['windowDurationMinutes'] ?? window['window_minutes'],
    });
  };
  add('primary', 'session');
  add('secondary', 'weekly');

  return normalizeQuotaSample(
    { source: options.source ?? raw['source'], windows },
    options,
  );
}

/** Map an Antigravity `window` value onto the two supported window kinds. */
function antigravityWindowKind(value: unknown): UsageLimitWindowKind | undefined {
  if (typeof value !== 'string') return undefined;
  const window = value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (window === 'weekly' || window === 'week') return 'weekly';
  if (window === 'session' || window === 'rolling' || window === 'five hour' || window === '5 hour') return 'session';
  return undefined;
}

/** Convert a 0–1 remaining fraction to a 0–100 percentage. */
function percentFromFraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return Math.round(value * 1000) / 10;
}

/**
 * Map Antigravity's `/usage --output-format json` response onto the generic
 * contract. Each model group has its own buckets; because only one window per
 * kind can be stored, normalization keeps the most constrained group.
 */
export function quotaSampleFromAntigravityUsage(
  value: unknown,
  options: { now?: Date; source?: string } = {},
): NormalizedQuotaSample | undefined {
  const data = obj(obj(obj(value)?.['command'])?.['data']);
  const groups = Array.isArray(data?.['groups']) ? data['groups'] : [];
  const windows: QuotaWindowSample[] = [];
  for (const groupValue of groups) {
    const group = obj(groupValue);
    if (group === null) continue;
    const label = safeLabel(group['name']);
    const buckets = Array.isArray(group['buckets']) ? group['buckets'] : [];
    for (const bucketValue of buckets) {
      const bucket = obj(bucketValue);
      if (bucket === null) continue;
      const kind = antigravityWindowKind(bucket['window']);
      if (kind === undefined) continue;
      const remainingPercent = percentFromFraction(
        bucket['remaining_fraction'] ?? bucket['remainingFraction'],
      );
      if (remainingPercent === undefined) continue;
      const sample: QuotaWindowSample = { kind, remainingPercent };
      const resetsAt = bucket['reset_time'] ?? bucket['resetTime'] ?? bucket['resetsAt'] ?? bucket['resets_at'];
      if (typeof resetsAt === 'string' || typeof resetsAt === 'number') sample.resetsAt = resetsAt;
      if (label !== undefined) sample.label = label;
      windows.push(sample);
    }
  }
  return normalizeQuotaSample(
    { source: options.source ?? 'antigravity', windows },
    options,
  );
}

/**
 * Map the OpenCode Go usage endpoint onto the generic contract. `percent` is
 * already consumed, unlike Antigravity's remaining fraction. The monthly window
 * has no UI representation and is intentionally ignored.
 */
export function quotaSampleFromOpenCodeGoUsage(
  value: unknown,
  options: { now?: Date; source?: string } = {},
): NormalizedQuotaSample | undefined {
  const usage = obj(obj(value)?.['usage']);
  if (usage === null) return undefined;

  const windows: QuotaWindowSample[] = [];
  const add = (key: 'rolling' | 'weekly', kind: UsageLimitWindowKind): void => {
    const window = obj(usage[key]);
    if (window === null) return;
    const percent = window['percent'];
    if (typeof percent !== 'number') return;
    const sample: QuotaWindowSample = { kind, usedPercent: percent };
    const resetsAt = window['resetsAt'] ?? window['resets_at'];
    if (typeof resetsAt === 'string' || typeof resetsAt === 'number') sample.resetsAt = resetsAt;
    windows.push(sample);
  };
  add('rolling', 'session');
  add('weekly', 'weekly');

  return normalizeQuotaSample(
    { source: options.source ?? 'opencode', windows },
    options,
  );
}

/** A locally observed OpenCode free-tier state. */
export interface OpenCodeFreeTierState {
  /** Whether a free model was used in the recent daily window. */
  freeModelsUsed?: boolean;
  /** When an observed free-limit block ends, if it is still in the future. */
  blockedUntil?: Date | string | number;
}

/** The next midnight UTC, OpenCode's reset boundary for free usage. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * Map OpenCode's free tier onto a daily window.
 *
 * OpenCode does not publish a free-tier percentage. It only returns a 429 with
 * a retry time once the daily limit is reached, so `usedPercent: 100` is set
 * only for an observed block. An unblocked day still gets the window and its
 * midnight-UTC reset, with the percentage deliberately unreported.
 */
export function quotaSampleFromOpenCodeFreeTier(
  value: OpenCodeFreeTierState,
  options: { now?: Date; source?: string } = {},
): NormalizedQuotaSample | undefined {
  const now = options.now ?? new Date();
  const blockedUntil = value.blockedUntil === undefined ? undefined : new Date(value.blockedUntil);
  const blocked = blockedUntil !== undefined
    && Number.isFinite(blockedUntil.getTime())
    && blockedUntil.getTime() > now.getTime();
  if (!blocked && value.freeModelsUsed !== true) return undefined;

  const reset = blocked ? blockedUntil! : nextUtcMidnight(now);
  return normalizeQuotaSample({
    source: options.source ?? 'opencode',
    windows: [{
      kind: 'daily',
      ...(blocked ? { usedPercent: 100 } : {}),
      resetsAt: reset.getTime(),
      windowMinutes: 1440,
      label: 'Free models',
    }],
  }, options);
}

/** The quota an adapter stream event reports, if any. */
export function quotaFromEvent(ev: AdapterStreamEvent): NormalizedQuotaSample | undefined {
  if (ev.kind !== 'log') return undefined;
  // Judge window expiry as of when the event was emitted, not the wall clock:
  // replayed/checkpointed events keep their original `at`, and callers
  // re-normalize through QuotaRecorder with the recording time before storing.
  const at = new Date(ev.at);
  return normalizeQuotaSample(obj(ev.data)?.['quota'], Number.isFinite(at.getTime()) ? { now: at } : {});
}

/**
 * Whether a stored limit is still current. A window with no reset time is
 * always current; one whose reset has passed (or cannot be parsed) is not.
 */
export function isQuotaWindowCurrent(
  window: Pick<UsageLimitWindow, 'resetsAt'>,
  now: Date = new Date(),
): boolean {
  if (window.resetsAt === undefined) return true;
  const time = Date.parse(window.resetsAt);
  return Number.isFinite(time) && time > now.getTime();
}

const UPSERT = `INSERT INTO agent_usage_limits
  (adapter_id, window_kind, label, remaining_percent, used_percent, resets_at, reported_at, source, window_minutes, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(adapter_id, window_kind) DO UPDATE SET
    label = excluded.label,
    remaining_percent = excluded.remaining_percent,
    used_percent = excluded.used_percent,
    resets_at = excluded.resets_at,
    reported_at = excluded.reported_at,
    source = excluded.source,
    window_minutes = excluded.window_minutes,
    updated_at = excluded.updated_at`;

/**
 * Stores the latest quota snapshot per adapter and window kind. Samples are
 * normalized first, so malformed or expired windows are never written.
 */
export class QuotaRecorder {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(input: { adapterId: string; sample: unknown }): void {
    const adapterId = safeSource(input.adapterId);
    if (adapterId === undefined) return;
    const now = this.now();
    const sample = normalizeQuotaSample(input.sample, { source: adapterId, now });
    if (sample === undefined) return;
    const at = now.toISOString();
    const statement = this.store.db.prepare(UPSERT);
    for (const window of sample.windows) {
      statement.run(
        adapterId,
        window.kind,
        window.label ?? null,
        window.remainingPercent ?? null,
        window.usedPercent ?? null,
        window.resetsAt ?? null,
        at,
        sample.source ?? adapterId,
        window.windowMinutes ?? null,
        at,
      );
    }
  }
}
