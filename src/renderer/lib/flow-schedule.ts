// Friendly schedules for flows, kept as the 5-field cron expression the app stores.

export type ScheduleKind = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
export interface SchedulePreset { kind: ScheduleKind; every: number; time: string; day: number; cron: string }

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const pad = (n: number): string => String(n).padStart(2, '0');

export function buildCron(preset: Pick<SchedulePreset, 'kind' | 'every' | 'time' | 'day' | 'cron'>): string {
  const [hour = '9', minute = '0'] = preset.time.split(':').map((part) => String(Number(part)));
  switch (preset.kind) {
    case 'minutes': return `*/${Math.max(1, Math.min(59, Math.round(preset.every)))} * * * *`;
    case 'hourly': return `${minute} * * * *`;
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': return `${minute} ${hour} * * ${preset.day}`;
    case 'custom': return preset.cron;
  }
}

/** Recognise a stored cron as one of the presets, or custom. */
export function readCron(cron: string): SchedulePreset {
  const base = { every: 15, time: '09:00', day: 1, cron };
  const parts = cron.trim().split(/\s+/);
  const [m = '', h = '', dom = '', mon = '', dow = ''] = parts;
  const at = (): string => `${pad(Number(h))}:${pad(Number(m))}`;
  const num = /^\d{1,2}$/;
  if (parts.length === 5 && dom === '*' && mon === '*') {
    const every = /^\*\/(\d{1,2})$/.exec(m);
    if (every !== null && h === '*' && dow === '*') return { ...base, kind: 'minutes', every: Number(every[1]) };
    if (num.test(m) && h === '*' && dow === '*') return { ...base, kind: 'hourly', time: `09:${pad(Number(m))}` };
    if (num.test(m) && num.test(h) && dow === '*') return { ...base, kind: 'daily', time: at() };
    if (num.test(m) && num.test(h) && dow === '1-5') return { ...base, kind: 'weekdays', time: at() };
    if (num.test(m) && num.test(h) && /^[0-6]$/.test(dow)) return { ...base, kind: 'weekly', time: at(), day: Number(dow) };
  }
  return { ...base, kind: 'custom' };
}

export function describeCron(cron: string): string {
  const preset = readCron(cron);
  switch (preset.kind) {
    case 'minutes': return `Every ${preset.every} minute${preset.every === 1 ? '' : 's'}`;
    case 'hourly': return `Every hour at :${preset.time.slice(3)}`;
    case 'daily': return `Every day at ${preset.time}`;
    case 'weekdays': return `Weekdays at ${preset.time}`;
    case 'weekly': return `${WEEKDAYS[preset.day]}s at ${preset.time}`;
    case 'custom': return `Cron ${cron}`;
  }
}
