import type { Connector, ConnectorLifecycle, RetrieveResult } from '@shared/connector';
import { NetworkAccess } from './network-access';
import { parseCalendar, type CalendarEvent } from './ics';

// Calendar connector (kind `calendar`) for iCalendar feeds: Google Calendar's
// "secret address in iCal format", iCloud shared calendars, Outlook published
// calendars, Fastmail, CalDAV export links. The feed URL embeds a credential,
// so it is stored in the Keychain and substituted only at egress.
//
// Each sync reads events from 7 days ago to 60 days ahead; unchanged events
// are deduplicated by content hash and changed ones supersede their memory.

export const PAST_DAYS = 7;
export const FUTURE_DAYS = 60;
export const MAX_FEED_BYTES = 10 * 1024 * 1024;

export type FeedFetcher = (url: string, signal: AbortSignal) => Promise<string>;

export const httpFeedFetcher: FeedFetcher = async (url, signal) => {
  const response = await fetch(url, { signal, redirect: 'follow', headers: { accept: 'text/calendar, */*;q=0.5' } });
  if (!response.ok) throw new Error(`Calendar feed returned HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_FEED_BYTES) throw new Error('Calendar feed is larger than 10 MB');
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) throw new Error('Calendar feed is larger than 10 MB');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('The URL did not return an iCalendar feed');
  return text;
};

/** Normalize webcal:// links and require HTTPS. */
export function normalizeFeedUrl(raw: string): URL {
  const url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
  if (url.protocol !== 'https:') throw new Error('Calendar feed URL must use https:// or webcal://');
  return url;
}

function formatWhen(event: CalendarEvent): string {
  const opts: Intl.DateTimeFormatOptions = event.allDay
    ? { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }
    : { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  const start = event.start.toLocaleString('en-US', opts);
  if (event.end === undefined || event.allDay) return event.allDay ? `${start} (all day)` : start;
  return `${start} – ${event.end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function renderEvent(event: CalendarEvent): string {
  return [
    `Event: ${event.summary}`,
    `When: ${formatWhen(event)}`,
    `Starts (ISO): ${event.start.toISOString()}`,
    ...(event.location ? [`Where: ${event.location}`] : []),
    ...(event.organizer ? [`Organizer: ${event.organizer}`] : []),
    ...(event.status ? [`Status: ${event.status}`] : []),
    ...(event.description ? ['', event.description.slice(0, 8000)] : []),
  ].join('\n');
}

export class CalendarConnectorLifecycle implements ConnectorLifecycle {
  readonly kind = 'calendar' as const;

  constructor(
    private readonly network: NetworkAccess,
    private readonly fetcher: FeedFetcher = httpFeedFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  static provider(label: string): string {
    return `calendar:${label.toLowerCase()}`;
  }

  private async read(connector: Connector): Promise<string> {
    const config = connector.config.calendar;
    if (config === undefined) throw new Error('This calendar connector has no feed configured.');
    return this.network.egress(connector, {
      provider: CalendarConnectorLifecycle.provider(config.label),
      target: config.label,
      request: { url: NetworkAccess.placeholder(config.secretId) },
    }, async ({ url }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, 30_000);
      try {
        return await this.fetcher(normalizeFeedUrl(url).toString(), controller.signal);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async authorize(connector?: Connector): Promise<void> {
    if (connector === undefined) throw new Error('Connector required');
    await this.read(connector);
  }

  async retrieve(_cursor: string | undefined, connector?: Connector): Promise<RetrieveResult> {
    if (connector === undefined) throw new Error('Connector required');
    const text = await this.read(connector);
    const now = this.now();
    const events = parseCalendar(text, { from: new Date(now - PAST_DAYS * 86_400_000), to: new Date(now + FUTURE_DAYS * 86_400_000) });
    return {
      items: events.map((event) => ({
        externalId: `${event.uid}@${event.start.toISOString()}`,
        content: renderEvent(event),
        sourceTimestamp: event.start.toISOString(),
        permissions: [`calendar_read:${connector.config.calendar?.label ?? 'feed'}`],
        origin: `Event · ${event.summary}`,
      })),
      // Feeds have no incremental protocol (no cursor): each sync re-reads the
      // moving window and content-hash dedup skips unchanged events.
    };
  }

  async revoke(): Promise<void> {}
}
