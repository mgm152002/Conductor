import { useCallback, useEffect, useRef, useState } from 'react';
import type { Suggestion } from '@shared/domain';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Button } from '../ui/primitives';
import { SparklesIcon, XIcon } from '../ui/icons';

// Proactive suggestions: a sidebar inbox and a non-blocking toast when a new
// one surfaces. Nothing runs without the user's click unless they chose
// "Always" for that kind of action (and permissions allow it).

function usePendingSuggestions(): { pending: Suggestion[]; latest: Suggestion | null; refresh: () => void; clearLatest: () => void } {
  const [all, setAll] = useState<Suggestion[]>([]);
  const [latest, setLatest] = useState<Suggestion | null>(null);
  const refresh = useCallback(() => {
    void window.conductor.suggestions.list().then(setAll).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    return window.conductor.on('suggestion.surfaced', (payload) => {
      const suggestion = payload as Suggestion;
      if (typeof suggestion?.id === 'string') {
        if (suggestion.status === 'suggested' || suggestion.status === 'awaiting_authorization') setLatest(suggestion);
        refresh();
      }
    });
  }, [refresh]);
  return {
    pending: all.filter((s) => s.status === 'suggested' || s.status === 'awaiting_authorization'),
    latest,
    refresh,
    clearLatest: () => { setLatest(null); },
  };
}

function SuggestionCard({ suggestion, onDone, compact = false }: { suggestion: Suggestion; onDone: () => void; compact?: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runnable = suggestion.action.kind !== 'review_agent_setup';
  async function act(run: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError(null);
    try { await run(); onDone(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not complete the suggestion'); }
    finally { setBusy(false); }
  }
  return (
    <div className={cn('flex flex-col gap-1.5', !compact && 'rounded-xl border border-border p-3')}>
      <p className="text-2xs text-muted-foreground">{suggestion.trigger.summary} · {relativeTime(suggestion.createdAt)}</p>
      <p className="text-[13px] font-medium text-foreground">{suggestion.action.summary}</p>
      <p className="text-2xs text-muted-foreground">{suggestion.explanation}</p>
      {suggestion.status === 'awaiting_authorization' ? <p className="text-2xs text-warning">This action affects something outside Conductor and needs your approval.</p> : null}
      {error !== null ? <p role="alert" className="text-2xs text-destructive-foreground">{error}</p> : null}
      <div className="mt-1 flex flex-wrap gap-1.5">
        {runnable ? <Button size="xs" variant="primary" disabled={busy} onClick={() => { void act(() => window.conductor.suggestions.confirm({ id: suggestion.id })); }}>Do it</Button> : null}
        {runnable && suggestion.status === 'suggested' ? (
          <Button size="xs" variant="outline" disabled={busy} title="Run this kind of action automatically from now on, when permissions allow" onClick={() => { void act(() => window.conductor.suggestions.confirm({ id: suggestion.id, always: true })); }}>Always</Button>
        ) : null}
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void act(() => window.conductor.suggestions.dismiss(suggestion.id)); }}>{runnable ? 'Dismiss' : 'Got it'}</Button>
      </div>
    </div>
  );
}

export function SuggestionsInbox(): React.JSX.Element {
  const { pending, latest, refresh, clearLatest } = usePendingSuggestions();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (latest === null) return;
    const timer = window.setTimeout(clearLatest, 10_000);
    return () => { window.clearTimeout(timer); };
  }, [latest, clearLatest]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => { if (panel.current !== null && !panel.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={panel} className="relative">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); refresh(); }}
        aria-expanded={open}
        aria-label={`Suggestions${pending.length > 0 ? ` (${pending.length})` : ''}`}
        title="Suggestions"
        className="relative flex size-7 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <SparklesIcon size={14} />
        {pending.length > 0 ? <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground tabular-nums">{pending.length}</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Suggestions" className="absolute top-9 left-0 z-50 w-80 rounded-2xl border border-border bg-card p-3 shadow-2xl">
          <p className="mb-2 text-xs font-semibold text-foreground">Suggestions</p>
          {pending.length === 0 ? <p className="py-4 text-center text-2xs text-muted-foreground">Nothing needs your attention.</p> : (
            <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
              {pending.map((suggestion) => <li key={suggestion.id}><SuggestionCard suggestion={suggestion} onDone={refresh} /></li>)}
            </ul>
          )}
        </div>
      ) : null}
      {latest !== null && !open ? (
        <div role="status" className="fixed right-4 bottom-4 z-50 w-80 rounded-2xl border border-border bg-card p-3 shadow-2xl">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-2xs font-medium text-primary"><SparklesIcon size={12} />Suggestion</span>
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss notification" onClick={clearLatest}><XIcon size={12} /></Button>
          </div>
          <SuggestionCard compact suggestion={latest} onDone={() => { clearLatest(); refresh(); }} />
        </div>
      ) : null}
    </div>
  );
}
