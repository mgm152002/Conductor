import { useCallback, useEffect, useState } from 'react';
import type { FlowNodeStatus, FlowRun } from '@shared/agent-flows';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Alert, Button, EmptyState } from '../ui/primitives';
import { ClockIcon, Spinner } from '../ui/icons';
import { message } from './AgentDialog';

type Item = FlowRun & { flowName: string; labels: Record<string, string> };

const STATUS_TEXT: Record<FlowNodeStatus, string> = { waiting: 'Waiting', running: 'Working…', done: 'Done', failed: 'Failed', skipped: 'Skipped' };
const dot = (status: FlowNodeStatus | FlowRun['status']): string => (status === 'running' ? 'bg-info' : status === 'done' ? 'bg-success' : status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/40');

const duration = (run: FlowRun): string => {
  const end = run.finishedAt !== null ? new Date(run.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
};

/** Every flow run, newest first: what each step did and said. Runs are kept here, not in the agents' chats. */
export function FlowHistory({ onOpenFlow }: { onOpenFlow: (flowId: string) => void }): React.JSX.Element {
  const [runs, setRuns] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRuns(await window.conductor.flows.history()); } catch (err) { setError(message(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const live = runs?.some((run) => run.status === 'running') === true;
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, live ? 2_000 : 10_000);
    return () => { window.clearInterval(timer); };
  }, [live, load]);

  async function stop(runId: string): Promise<void> {
    setStopping(runId); setError(null);
    try { await window.conductor.flows.stopRun(runId); await load(); }
    catch (err) { setError(message(err)); }
    finally { setStopping(null); }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <ClockIcon size={16} className="text-muted-foreground" />
        <h2 className="flex-1 font-display text-[15px] font-semibold text-foreground">Workflow history</h2>
        {live ? <span className="flex items-center gap-1.5 text-2xs text-info"><Spinner size={12} />Running</span> : null}
      </header>
      {error !== null ? <div className="px-4 pt-3"><Alert action={<Button size="xs" variant="ghost" onClick={() => { setError(null); }}>Dismiss</Button>}>{error}</Alert></div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {runs === null ? <div className="flex justify-center p-8"><Spinner size={18} /></div>
          : runs.length === 0 ? <EmptyState title="No runs yet" description="Runs of your flows, by hand or on a schedule, are listed here." />
            : (
              <ul className="mx-auto flex max-w-3xl flex-col gap-2">
                {runs.map((run) => (
                  <li key={run.id} className="rounded-2xl border border-border bg-card">
                    <div className="flex items-center gap-3 px-3.5 py-3">
                      <span className={cn('size-2 shrink-0 rounded-full', dot(run.status))} />
                      <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" aria-expanded={open === run.id} onClick={() => { setOpen(open === run.id ? null : run.id); }}>
                        <span className="block truncate text-[13px] font-semibold text-foreground">{run.flowName}</span>
                        <span className="block text-2xs text-muted-foreground">
                          {run.status === 'running' ? 'Running' : run.status === 'done' ? 'Finished' : 'Failed or stopped'} · {run.trigger === 'schedule' ? 'scheduled' : 'by hand'} · {relativeTime(run.startedAt)} · {duration(run)}
                        </span>
                      </button>
                      {run.status === 'running' ? <Button size="sm" variant="outline" disabled={stopping === run.id} onClick={() => { void stop(run.id); }}>{stopping === run.id ? <Spinner size={12} /> : null}Stop</Button> : null}
                      <Button size="sm" variant="ghost" onClick={() => { onOpenFlow(run.flowId); }}>Open flow</Button>
                    </div>
                    {open === run.id ? (
                      <ol className="flex flex-col gap-2 border-t border-border px-3.5 py-3">
                        {run.nodes.map((node) => (
                          <li key={node.nodeId} className="flex flex-col gap-1">
                            <span className="flex items-center gap-2 text-xs font-medium text-foreground"><span className={cn('size-1.5 rounded-full', dot(node.status))} />{run.labels[node.nodeId] ?? 'Step'}<span className="font-normal text-muted-foreground">· {STATUS_TEXT[node.status]}</span></span>
                            {node.note !== '' ? <span className="pl-3.5 text-2xs text-muted-foreground">{node.note}</span> : null}
                            {node.output !== '' ? <span className="max-h-48 overflow-y-auto rounded-xl bg-muted/60 p-2.5 pl-3.5 text-2xs whitespace-pre-wrap text-muted-foreground">{node.output}</span> : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
      </div>
    </div>
  );
}
