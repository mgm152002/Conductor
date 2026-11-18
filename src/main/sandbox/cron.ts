// A 5-field cron expression (minute hour day-of-month month day-of-week) in
// local time: lists (1,5), ranges (1-5), steps (*/15, 1-30/5), and `*`.
// Day-of-week is 0-7 (0 and 7 are Sunday). When both day fields are limited,
// a day matches if either does, as in standard cron.

interface Field { values: Set<number>; any: boolean }
export interface Cron { minute: Field; hour: Field; dom: Field; month: Field; dow: Field }

function field(text: string, min: number, max: number, wrap7 = false): Field | undefined {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let lo: number; let hi: number;
    if (range === '*') { lo = min; hi = max; }
    else {
      const [a = '', b] = range.split('-');
      lo = Number(a); hi = b === undefined ? (stepText === undefined ? lo : max) : Number(b);
      if (!/^\d+$/.test(a) || (b !== undefined && !/^\d+$/.test(b))) return undefined;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > (wrap7 ? 7 : max) || lo > hi) return undefined;
    for (let value = lo; value <= hi; value += step) values.add(wrap7 && value === 7 ? 0 : value);
  }
  return { values, any: text === '*' || text.startsWith('*/') };
}

export function parseCron(expression: string): Cron | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const minute = field(parts[0]!, 0, 59);
  const hour = field(parts[1]!, 0, 23);
  const dom = field(parts[2]!, 1, 31);
  const month = field(parts[3]!, 1, 12);
  const dow = field(parts[4]!, 0, 6, true);
  return minute && hour && dom && month && dow ? { minute, hour, dom, month, dow } : undefined;
}

function dayMatches(cron: Cron, date: Date): boolean {
  const dom = cron.dom.values.has(date.getDate());
  const dow = cron.dow.values.has(date.getDay());
  if (cron.dom.any && cron.dow.any) return true;
  if (cron.dom.any) return dow;
  if (cron.dow.any) return dom;
  return dom || dow;
}

/** The first matching minute strictly after `after`, within the next 5 years; undefined when invalid or never. */
export function nextCronRun(expression: string, after: Date): Date | undefined {
  const cron = parseCron(expression);
  if (cron === undefined) return undefined;
  const date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (date.getTime() <= limit) {
    if (!cron.month.values.has(date.getMonth() + 1)) { date.setMonth(date.getMonth() + 1, 1); date.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(cron, date)) { date.setDate(date.getDate() + 1); date.setHours(0, 0, 0, 0); continue; }
    if (!cron.hour.values.has(date.getHours())) { date.setHours(date.getHours() + 1, 0, 0, 0); continue; }
    if (!cron.minute.values.has(date.getMinutes())) { date.setMinutes(date.getMinutes() + 1, 0, 0); continue; }
    return date;
  }
  return undefined;
}
