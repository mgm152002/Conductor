import { useCallback, useEffect, useState } from 'react';
import type { FlowNodeStatus, FlowRun } from '@shared/agent-flows';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Alert, Button, EmptyState } from '../ui/primitives';
import { ArrowLeftIcon, ChevronRightIcon, GlobeIcon, PlayIcon, Spinner } from '../ui/icons';
import { RunMarkdown } from './RunMarkdown';
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
export function FlowHistory({ onOpenFlow, onBack }: { onOpenFlow: (flowId: string) => void; onBack: () => void }): React.JSX.Element {
  const [runs, setRuns] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);
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

  async function rerun(run: Item): Promise<void> {
    setRerunning(run.id); setError(null);
    try { await window.conductor.flows.run(run.flowId, run.input); await load(); }
    catch (err) { setError(message(err)); }
    finally { setRerunning(null); }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="window-header flex shrink-0 items-center gap-1.5 border-b border-border px-4">
        <Button size="icon-sm" variant="ghost" aria-label="Back to workflows" title="Back" onClick={onBack}><ArrowLeftIcon size={14} /></Button>
        <h2 className="flex-1 text-sm font-medium text-foreground">Run history</h2>
        {live ? <span className="flex items-center gap-1.5 text-xs text-info"><Spinner size={12} />Running</span> : null}
      </header>
      {error !== null ? <div className="px-4 pt-3"><Alert action={<Button size="xs" variant="ghost" onClick={() => { setError(null); }}>Dismiss</Button>}>{error}</Alert></div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-4xl px-5 pt-6 pb-12 sm:px-6">
          {runs === null ? <div className="flex justify-center p-8"><Spinner size={18} /></div>
            : runs.length === 0 ? <EmptyState title="No runs yet" description="Runs of your flows appear here, newest first." />
              : (
                // Grouped list: one rounded card, hairline rows, actions on the right.
                <ul className="overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 *:not-first:border-t *:not-first:border-border/50">
                  {runs.map((run) => {
                    const expanded = open === run.id;
                    return (
                      <li key={run.id} className="group/run">
                        <div className="flex min-h-14 items-center gap-3 px-3 py-2 sm:px-4">
                          <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md" aria-expanded={expanded} onClick={() => { setOpen(expanded ? null : run.id); }}>
                            <ChevronRightIcon size={14} className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                            <span className={cn('size-2 shrink-0 rounded-full', dot(run.status), run.status === 'running' && 'animate-status-pulse')} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-foreground">{run.flowName}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {run.status === 'running' ? 'Running' : run.status === 'done' ? 'Finished' : 'Failed or stopped'} · {run.trigger === 'schedule' ? 'scheduled' : 'by hand'} · {relativeTime(run.startedAt)} · {duration(run)}
                              </span>
                            </span>
                          </button>
                          <span className="flex shrink-0 items-center gap-1">
                            {run.status === 'running' ? <Button size="sm" variant="ghost" title="Watch the flow’s browser live" onClick={() => { window.conductor.sandbox.openFlowViewer(run.flowId).catch((err: unknown) => { setError(message(err)); }); }}><GlobeIcon size={12} />Watch</Button> : null}
                            {run.status === 'running' ? <Button size="sm" variant="outline" disabled={stopping === run.id} onClick={() => { void stop(run.id); }}>{stopping === run.id ? <Spinner size={12} /> : null}Stop</Button>
                              : <Button size="sm" variant="ghost" disabled={rerunning === run.id || runs.some((other) => other.flowId === run.flowId && other.status === 'running')} title="Start this flow again with the same input" onClick={() => { void rerun(run); }}>{rerunning === run.id ? <Spinner size={12} /> : <PlayIcon size={12} />}Run again</Button>}
                            <Button size="sm" variant="ghost" onClick={() => { onOpenFlow(run.flowId); }}>Open flow</Button>
                          </span>
                        </div>
                        {expanded ? (
                          <ol className="flex flex-col gap-5 border-t border-border/50 bg-background/40 px-4 py-4 sm:px-6">
                            {run.nodes.map((node) => (
                              <li key={node.nodeId} className="flex flex-col gap-2">
                                <span className="flex items-center gap-2 text-sm">
                                  <span className={cn('size-1.5 rounded-full', dot(node.status))} />
                                  <span className="font-medium text-foreground">{run.labels[node.nodeId] ?? 'Step'}</span>
                                  <span className="text-muted-foreground">{STATUS_TEXT[node.status]}</span>
                                </span>
                                {node.note !== '' ? <span className="ps-3.5 text-xs text-muted-foreground">{node.note}</span> : null}
                                {node.output !== '' ? <div className="ms-3.5 max-h-80 overflow-y-auto border-s border-border ps-4"><RunMarkdown text={node.output} /></div> : null}
                              </li>
                            ))}
                          </ol>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
        </div>
      </div>
    </div>
  );
}
