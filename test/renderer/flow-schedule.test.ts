import { describe, expect, it } from 'vitest';
import { buildCron, describeCron, readCron } from '../../src/renderer/lib/flow-schedule';

describe('flow schedules', () => {
  it('round-trips each preset through its cron expression', () => {
    const base = { every: 15, time: '09:30', day: 3, cron: '' };
    for (const [kind, cron] of [['minutes', '*/15 * * * *'], ['hourly', '30 * * * *'], ['daily', '30 9 * * *'], ['weekdays', '30 9 * * 1-5'], ['weekly', '30 9 * * 3']] as const) {
      expect(buildCron({ ...base, kind }), kind).toBe(cron);
      expect(readCron(cron).kind, cron).toBe(kind);
    }
    expect(readCron('0 9 1 * *').kind).toBe('custom');
    expect(buildCron({ ...base, kind: 'custom', cron: '0 9 1 * *' })).toBe('0 9 1 * *');
  });
  it('describes them in words', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
    expect(describeCron('0 18 * * 1-5')).toBe('Weekdays at 18:00');
    expect(describeCron('0 8 * * 0')).toBe('Sundays at 08:00');
  });
});
