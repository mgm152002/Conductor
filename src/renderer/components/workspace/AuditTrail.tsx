import { useEffect, useState } from 'react';
import type { AuditEvent } from '@shared/domain';

function mergeEvents(current: AuditEvent[], incoming: AuditEvent[]): AuditEvent[] {
  const unique = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) unique.set(event.id, event);
  return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 100);
}

export function AuditTrail(): React.JSX.Element {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    let loaded = false;
    const receivedDuringLoad: AuditEvent[] = [];
    setLoading(true);
    setError(null);
    void window.conductor.audit.list({ limit: 100 }).then((list) => {
      if (active) setEvents(mergeEvents(receivedDuringLoad, list));
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Could not load the audit trail');
    }).finally(() => { loaded = true; if (active) setLoading(false); });
    const unsubscribe = window.conductor.on('audit.appended', (payload) => {
      const event = payload as AuditEvent;
      if (event && typeof event.id === 'string' && typeof event.createdAt === 'string') {
        if (!loaded) receivedDuringLoad.push(event);
        setEvents((current) => mergeEvents(current, [event]));
      }
    });
    return () => { active = false; unsubscribe(); };
  }, [version]);
  return <section aria-label="Application audit trail" className="flex flex-col gap-3">
    <header className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-foreground">Application audit trail</h2><p className="mt-1 text-xs text-muted-foreground">The latest 100 recorded operations across all workspaces.</p></div><button type="button" disabled={loading} onClick={() => { setVersion((value) => value + 1); }} className="rounded-md border border-input px-3 py-1 text-xs disabled:opacity-40">{loading ? 'Loading…' : 'Refresh'}</button></header>
    {error !== null ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
    {!loading && events.length === 0 ? <p className="text-sm text-muted-foreground">No audit events have been recorded yet.</p> : null}
    <ol className="flex flex-col gap-2">{events.map((event) => <li key={event.id} className="rounded-lg border border-border p-3"><div className="flex flex-wrap justify-between gap-2 text-xs"><span className="font-medium text-foreground">{event.action}</span><time className="text-muted-foreground" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></div><p className="mt-1 break-all text-xs text-muted-foreground">{event.actor}{event.target ? ` · ${event.target}` : ''}</p><details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Recorded details</summary><pre className="mt-1 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(event.redactedPayload, null, 2)}</pre></details></li>)}</ol>
  </section>;
}
