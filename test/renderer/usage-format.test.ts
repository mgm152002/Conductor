import { describe, expect, it } from 'vitest';
import type { UsageRow } from '@shared/usage';
import {
  formatPercentLeft,
  formatResetCountdown,
  percentLeft,
  resetCountdown,
  usageBreakdown,
} from '../../src/renderer/lib/usage-format';

const row: UsageRow = {
  key: 'task', label: 'This message', sessions: 1,
  inputTokens: 12_300, cachedInputTokens: 2000, outputTokens: 4200,
  reasoningTokens: 500, totalTokens: 16_500,
};

describe('usage breakdown', () => {
  it('shows input, output, and output speed', () => {
    expect(usageBreakdown(row, 72_000)).toBe('12k in · 4.2k out · 58 tok/s');
  });
  it('omits speed when the duration is unknown', () => {
    expect(usageBreakdown(row)).toBe('12k in · 4.2k out');
    expect(usageBreakdown(row, 0)).toBe('12k in · 4.2k out');
  });
});

describe('percent left', () => {
  it('prefers the reported remaining percentage', () => {
    expect(percentLeft({ remainingPercent: 12 })).toBe(12);
    expect(percentLeft({ remainingPercent: 0 })).toBe(0);
    expect(percentLeft({ remainingPercent: 12, usedPercent: 30 })).toBe(12);
  });

  it('derives the remaining percentage from the used percentage', () => {
    expect(percentLeft({ usedPercent: 88 })).toBe(12);
    expect(percentLeft({ usedPercent: 0 })).toBe(100);
    expect(percentLeft({ usedPercent: 100 })).toBe(0);
  });

  it('rounds and clamps into 0..100', () => {
    expect(percentLeft({ remainingPercent: 12.4 })).toBe(12);
    expect(percentLeft({ remainingPercent: 12.6 })).toBe(13);
    expect(percentLeft({ remainingPercent: 140 })).toBe(100);
    expect(percentLeft({ remainingPercent: -5 })).toBe(0);
    expect(percentLeft({ usedPercent: -20 })).toBe(100);
  });

  it('falls back to used percent when remaining is not a finite number', () => {
    expect(percentLeft({ remainingPercent: Number.NaN, usedPercent: 20 })).toBe(80);
    expect(percentLeft({ remainingPercent: Number.POSITIVE_INFINITY, usedPercent: 20 })).toBe(80);
  });

  it('is undefined rather than zero when nothing was reported', () => {
    expect(percentLeft(undefined)).toBeUndefined();
    expect(percentLeft(null)).toBeUndefined();
    expect(percentLeft({})).toBeUndefined();
  });

  it('formats a reported window and the not-reported state', () => {
    expect(formatPercentLeft({ remainingPercent: 12 })).toBe('12%');
    expect(formatPercentLeft({ usedPercent: 100 })).toBe('0%');
    expect(formatPercentLeft({})).toBe('Not reported');
    expect(formatPercentLeft(null)).toBe('Not reported');
  });
});

describe('reset countdown', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const inMs = (ms: number): string => new Date(now + ms).toISOString();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('formats days, hours, and minutes', () => {
    expect(resetCountdown(inMs(5 * DAY), now)).toBe('5d 0h');
    expect(resetCountdown(inMs(DAY + 2 * HOUR + 30 * MINUTE), now)).toBe('1d 2h');
    expect(resetCountdown(inMs(HOUR + 3 * MINUTE), now)).toBe('1h 3m');
    expect(resetCountdown(inMs(12 * MINUTE), now)).toBe('12m');
    expect(resetCountdown(inMs(59 * 1000), now)).toBe('<1m');
  });

  it('accepts a limit window, a date, or a timestamp', () => {
    expect(resetCountdown({ resetsAt: inMs(HOUR) }, now)).toBe('1h 0m');
    expect(resetCountdown(inMs(HOUR), new Date(now))).toBe('1h 0m');
  });

  it('returns undefined for a missing, invalid, or already-passed reset', () => {
    expect(resetCountdown(undefined, now)).toBeUndefined();
    expect(resetCountdown(null, now)).toBeUndefined();
    expect(resetCountdown({}, now)).toBeUndefined();
    expect(resetCountdown('not a date', now)).toBeUndefined();
    expect(resetCountdown(inMs(0), now)).toBeUndefined();
    expect(resetCountdown(inMs(-1), now)).toBeUndefined();
  });

  it('exposes the readable alias', () => {
    expect(formatResetCountdown).toBe(resetCountdown);
    expect(formatResetCountdown(inMs(2 * DAY), now)).toBe('2d 0h');
  });
});
