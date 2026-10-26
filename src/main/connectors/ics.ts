// A compact RFC 5545 (iCalendar) reader for calendar feeds: line unfolding,
// property parameters, text unescaping, UTC / floating / TZID date-times,
// all-day dates, and expansion of common recurrence rules (FREQ DAILY, WEEKLY
// with BYDAY, MONTHLY, YEARLY; INTERVAL, COUNT, UNTIL; EXDATE). Rules outside
// that subset (BYSETPOS, BYWEEKNO, …) fall back to the first occurrence.

export interface CalendarEvent {
  uid: string;
  summary: string;
  start: Date;
  end?: Date;
  allDay: boolean;
  location?: string;
  description?: string;
  organizer?: string;
  status?: string;
}

interface Property { name: string; params: Record<string, string>; value: string }

function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((line) => line.length > 0);
}

function parseLine(line: string): Property | undefined {
  // Split on the first ':' not inside a quoted parameter value.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) { colon = i; break; }
  }
  if (colon < 0) return undefined;
  const [rawName, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf('=');
    if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: (rawName ?? '').toUpperCase(), params, value: line.slice(colon + 1) };
}

export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

/** UTC offset (ms) of an IANA zone at a given instant. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - instant;
}

/** Wall-clock time in a zone → instant. */
function zonedTime(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  try {
    const first = guess - zoneOffset(guess, timeZone);
    return new Date(guess - zoneOffset(first, timeZone));
  } catch {
    return new Date(y, mo, d, h, mi, s); // unknown zone: treat as local time
  }
}

/** Calendar fields of an instant as observed in an IANA zone. */
function zonedParts(instant: number, timeZone: string): [number, number, number, number, number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return [get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')];
}

export function parseDate(property: Pick<Property, 'value' | 'params'>): { date: Date; allDay: boolean } | undefined {
  const value = property.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly || property.params['VALUE'] === 'DATE') {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!m) return undefined;
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (m[7] === 'Z') return { date: new Date(Date.UTC(y, mo, d, h, mi, s)), allDay: false };
  const tz = property.params['TZID'];
  return { date: tz ? zonedTime(y, mo, d, h, mi, s, tz) : new Date(y, mo, d, h, mi, s), allDay: false };
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_OCCURRENCES = 500;

/** Occurrence start times of a recurring event within [from, to]. */
export function expandRule(start: Date, rrule: string, from: Date, to: Date, exdates: ReadonlySet<number>, timeZone?: string): Date[] {
  const rule: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const [key, value] = part.split('=');
    if (key && value) rule[key.toUpperCase()] = value;
  }
  const freq = rule['FREQ'];
  if (!freq || ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE'].some((k) => k in rule)) {
    return start >= from && start <= to ? [start] : [];
  }
  const interval = Math.max(1, Number(rule['INTERVAL'] ?? '1') || 1);
  const count = rule['COUNT'] ? Number(rule['COUNT']) : Infinity;
  const until = rule['UNTIL'] ? parseDate({ value: rule['UNTIL'], params: {} })?.date : undefined;
  const byDay = rule['BYDAY']?.split(',').map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((d) => d >= 0);
  const out: Date[] = [];
  let emitted = 0;
  const consider = (when: Date): boolean => {
    if (until && when > until) return false;
    if (when < start) return true;
    emitted += 1;
    if (emitted > count) return false;
    if (when >= from && when <= to && !exdates.has(when.getTime())) out.push(when);
    return when <= to && out.length < MAX_OCCURRENCES;
  };
  const shifted = (base: Date, days: number, months = 0, years = 0): Date => {
    if (timeZone) {
      const [y, mo, d, h, mi, s] = zonedParts(base.getTime(), timeZone);
      const wall = new Date(Date.UTC(y, mo, d, h, mi, s));
      wall.setUTCFullYear(wall.getUTCFullYear() + years, wall.getUTCMonth() + months, wall.getUTCDate() + days);
      return zonedTime(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), timeZone);
    }
    const next = new Date(base);
    next.setFullYear(next.getFullYear() + years, next.getMonth() + months, next.getDate() + days);
    return next;
  };
  const weekday = (date: Date): number => timeZone
    ? new Date(Date.UTC(...zonedParts(date.getTime(), timeZone).slice(0, 3) as [number, number, number])).getUTCDay()
    : date.getDay();
  for (let i = 0; i < 5000; i += 1) {
    if (freq === 'DAILY') { if (!consider(shifted(start, i * interval))) break; continue; }
    if (freq === 'WEEKLY') {
      const startDay = weekday(start);
      const weekStart = shifted(start, i * 7 * interval - startDay);
      const days = byDay && byDay.length > 0 ? byDay : [startDay];
      let keepGoing = true;
      for (const day of [...days].sort((a, b) => a - b)) {
        if (!consider(shifted(weekStart, day))) { keepGoing = false; break; }
      }
      if (!keepGoing) break;
      continue;
    }
    if (freq === 'MONTHLY') { const next = shifted(start, 0, i * interval); if (next.getDate() !== start.getDate()) continue; if (!consider(next)) break; continue; }
    if (freq === 'YEARLY') { if (!consider(shifted(start, 0, 0, i * interval))) break; continue; }
    return start >= from && start <= to ? [start] : [];
  }
  return out;
}

/** Parse VEVENTs from an iCalendar document, expanding recurrences within the window. */
export function parseCalendar(text: string, window: { from: Date; to: Date }): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current: Property[] | null = null;
  let depth = 0;
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (prop === undefined) continue;
    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VEVENT') { current = []; depth = 0; continue; }
    if (current !== null && prop.name === 'BEGIN') { depth += 1; continue; } // nested VALARM
    if (current !== null && prop.name === 'END' && depth > 0) { depth -= 1; continue; }
    if (current !== null && prop.name === 'END' && prop.value.toUpperCase() === 'VEVENT') {
      events.push(...materialize(current, window));
      current = null;
      continue;
    }
    if (current !== null && depth === 0) current.push(prop);
  }
  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function materialize(props: Property[], window: { from: Date; to: Date }): CalendarEvent[] {
  const get = (name: string): Property | undefined => props.find((p) => p.name === name);
  const startProp = get('DTSTART');
  const start = startProp ? parseDate(startProp) : undefined;
  if (start === undefined) return [];
  const endProp = get('DTEND');
  const end = endProp ? parseDate(endProp)?.date : undefined;
  const duration = end !== undefined ? end.getTime() - start.date.getTime() : 0;
  const base = {
    uid: get('UID')?.value ?? `${start.date.getTime()}`,
    summary: unescapeText(get('SUMMARY')?.value ?? '(untitled event)'),
    allDay: start.allDay,
    ...(get('LOCATION') ? { location: unescapeText(get('LOCATION')!.value) } : {}),
    ...(get('DESCRIPTION') ? { description: unescapeText(get('DESCRIPTION')!.value) } : {}),
    ...(get('ORGANIZER') ? { organizer: get('ORGANIZER')!.params['CN'] ?? get('ORGANIZER')!.value.replace(/^mailto:/i, '') } : {}),
    ...(get('STATUS') ? { status: get('STATUS')!.value } : {}),
  };
  const rrule = get('RRULE')?.value;
  const exdates = new Set(props.filter((p) => p.name === 'EXDATE').flatMap((p) => p.value.split(',').map((v) => parseDate({ value: v, params: p.params })?.date.getTime() ?? NaN)));
  const starts = rrule ? expandRule(start.date, rrule, window.from, window.to, exdates, startProp?.params['TZID']) : (start.date <= window.to && (end ?? start.date) >= window.from ? [start.date] : []);
  return starts.map((when) => ({ ...base, start: when, ...(end !== undefined ? { end: new Date(when.getTime() + duration) } : {}) }));
}
