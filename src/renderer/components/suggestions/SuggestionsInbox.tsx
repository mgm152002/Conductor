import { useCallback, useEffect, useRef, useState } from 'react';
import type { Suggestion } from '@shared/domain';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Button } from '../ui/primitives';
import { InboxIcon, SparklesIcon, XIcon } from '../ui/icons';
import { useNavigate } from 'react-router-dom';
import { useNeedsAttentionThreads } from '../../hooks/useNeedsAttentionThreads';
import { useSandboxAgentStore } from '../../stores/sandbox-agent-store';
import { AgentAvatar } from '../ui/AgentAvatar';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import { useThreadTierStore } from '../../stores';
import { threadTitle } from '../../lib/thread-status';

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

export function SuggestionsInbox({ variant = 'inline' }: { /** `bar` renders as a top-bar icon whose panel opens under it, right-aligned. */ variant?: 'inline' | 'bar' } = {}): React.JSX.Element {
  const { pending, latest, refresh, clearLatest } = usePendingSuggestions();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const attention = useNeedsAttentionThreads();
  const { openThread } = useThreadNavigation();
  const navigate = useNavigate();
  const agents = useSandboxAgentStore((s) => s.agents);
  const agentThreads = useSandboxAgentStore((s) => s.threads);
  const total = pending.length + attention.length;

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
        aria-label={`Inbox${total > 0 ? ` (${total})` : ''}`}
        title="Inbox — suggestions and threads waiting on you"
        data-active={variant === 'bar' ? open : undefined}
        className={variant === 'bar' ? 'bar-icon relative' : 'relative flex size-7 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring'}
      >
        <InboxIcon size={15} />
        {total > 0 ? <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground tabular-nums">{total}</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Inbox" className={cn('animate-pop-in absolute top-9 z-50 w-80 rounded-2xl border border-border bg-surface-raised p-3 text-left shadow-pop', variant === 'bar' ? 'right-0' : 'left-0')}>
          <p className="mb-2 text-xs font-semibold text-foreground">Inbox</p>
          {total === 0 ? <p className="py-4 text-center text-2xs text-muted-foreground">Nothing needs your attention.</p> : (
            <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
              {attention.length > 0 ? (
                <section aria-label="Threads that need attention">
                  <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium text-amber-600 dark:text-amber-300/90">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500 dark:bg-amber-300/90" />
                    <span className="flex-1">Needs attention · {attention.length}</span>
                    <button
                      type="button"
                      onClick={() => { for (const { thread } of attention) useThreadTierStore.getState().markSettled(thread.key, thread.latest.updatedAt); }}
                      className="cursor-pointer rounded px-1 font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      Dismiss all
                    </button>
                  </p>
                  <ul className="flex flex-col gap-1">
                    {attention.map(({ thread, info }) => {
                      const agent = agents.find((candidate) => candidate.id === agentThreads[thread.key]);
                      return (
                      <li key={thread.key} className="group/note relative">
                        <button
                          type="button"
                          onClick={() => {
                            if (info.attentionReason === 'snooze-woke') useThreadTierStore.getState().clear(thread.key);
                            setOpen(false);
                            // An agent's thread opens in the Agents screen, on that conversation.
                            if (useSandboxAgentStore.getState().openThread(thread.key)) navigate('/agents');
                            else void openThread(thread.latest);
                          }}
                          className="flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {agent !== undefined ? <AgentAvatar agent={agent} size={22} /> : null}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-foreground">{threadTitle(thread.root)}</span>
                            {agent !== undefined ? <span className="block truncate text-3xs text-muted-foreground">{agent.name}</span> : null}
                          </span>
                          <span className="shrink-0 text-3xs font-medium text-amber-600 dark:text-amber-300/90">{info.attentionLabel}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Dismiss: ${threadTitle(thread.root)}`}
                          title="Dismiss"
                          onClick={() => { useThreadTierStore.getState().markSettled(thread.key, thread.latest.updatedAt); }}
                          className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-border hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <XIcon size={12} />
                        </button>
                      </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
              {pending.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {pending.map((suggestion) => <li key={suggestion.id}><SuggestionCard suggestion={suggestion} onDone={refresh} /></li>)}
                </ul>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {latest !== null && !open ? (
        <div role="status" className="fixed right-4 bottom-4 z-50 w-80 rounded-2xl border border-border bg-surface-raised p-3 shadow-pop">
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
