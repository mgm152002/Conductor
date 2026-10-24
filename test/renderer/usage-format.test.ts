import { describe, expect, it } from 'vitest';
import type { UsageRow } from '@shared/usage';
import { usageBreakdown } from '../../src/renderer/lib/usage-format';

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
