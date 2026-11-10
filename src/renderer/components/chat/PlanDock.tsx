import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { cn } from '../../lib/cn';
import { agentLabel } from '../../lib/usage-format';
import { ChevronRightIcon, LayersIcon, Spinner } from '../ui/icons';
import { PlanCard } from './PlanCard';
import { stepFallbacks } from '../../lib/timeline';

// The plan's tasks, pinned directly above the composer. It stays a compact
// one-line summary until clicked, then expands to the wave/task list and each
// task's status and live work log. The conversation keeps the per-task replies
// but no longer repeats the whole plan card inline on every turn.
export function PlanDock({ task, details }: { task: Task; details: TaskDetails | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  useEffect(() => { setOpen(false); }, [task.id]);

  const summary = useMemo(() => {
    const plan = details?.plan;
    if (plan === null || plan === undefined) return null;
    const tasks = plan.plan?.groups.flatMap((group) => group.tasks) ?? [];
    const steps = new Map((details?.steps ?? []).map((step) => [step.id, step]));
    const stepFor = (id: string) => steps.get(plan.steps?.[id] ?? '');
    const succeeded = tasks.filter((item) => stepFor(item.id)?.status === 'succeeded').length;
    const running = tasks.filter((item) => stepFor(item.id)?.status === 'running').map((item) => item.title);
    const failed = tasks.filter((item) => stepFor(item.id)?.status === 'failed').map((item) => item.title);
    // One measure per task, in plan order, so progress reads at a glance.
    const measures = tasks.map((item) => {
      const state = stepFor(item.id)?.status;
      return { id: item.id, title: item.title, state: state === 'succeeded' ? 'done' : state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'waiting' };
    });
    // Fallbacks across the plan's steps, newest last, for the summary line.
    const fallbacks = (details?.steps ?? []).flatMap((step) => stepFallbacks(details?.events ?? [], step.id))
      .sort((a, b) => a.at.localeCompare(b.at));
    return { plan, total: tasks.length, succeeded, running, failed, measures, fallbacks };
  }, [details]);

  if (details === null || summary === null) return null;
  const plan = summary.plan;
  const title = plan.plan?.title
    ?? (plan.status === 'failed'
      ? `${agentLabel(plan.plannerAdapterId)} could not write the plan`
      : `${agentLabel(plan.plannerAdapterId)} is writing the plan…`);
  const progress = plan.plan === undefined
    ? plan.status === 'failed' ? 'Plan failed' : 'Planning…'
    : `${summary.succeeded}/${summary.total} done`;
  const status = [
    summary.running.length > 0 ? `${summary.running.length} running` : null,
    summary.failed.length > 0 ? `${summary.failed.length} failed` : null,
  ].filter(Boolean).join(', ');
  const lastFallback = summary.fallbacks[summary.fallbacks.length - 1];
  const hint = open
    ? 'Click to collapse'
    : summary.running.length > 0
      ? `Running: ${summary.running.join(', ')}`
      : summary.total > 0
        ? 'Click to view tasks and status'
        : 'Click to view the plan';

  return (
    <section aria-label="Pinned plan tasks" className="mx-auto mb-2 w-full max-w-(--chat-max)">
      <div className="bar-card">
        <button
          type="button"
          onClick={() => { setOpen((value) => !value); }}
          aria-expanded={open}
          aria-controls="pinned-plan-tasks"
          className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-accent/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <LayersIcon size={14} className={cn('shrink-0', plan.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
              <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">{progress}</span>
              {status !== '' ? <span className="shrink-0 text-3xs text-muted-foreground">{status}</span> : null}
              {plan.plan === undefined && plan.status !== 'failed' ? <Spinner size={11} className="shrink-0 text-info" /> : null}
              {summary.fallbacks.length > 0 ? (
                <span
                  className="shrink-0 rounded-full bg-amber-500/12 px-1.5 py-px text-3xs font-medium text-amber-700 dark:text-amber-300"
                  title={summary.fallbacks.map((f) => `${f.fromAgent ?? 'Agent'} → ${f.toAgent}${f.reason !== undefined ? `: ${f.reason}` : ''}`).join('\n')}
                >
                  {summary.fallbacks.length === 1 ? '1 fallback' : `${summary.fallbacks.length} fallbacks`}
                </span>
              ) : null}
            </span>
            <span className="truncate text-3xs text-muted-foreground">
              {!open && lastFallback !== undefined
                ? `${lastFallback.kind === 'model' ? `${lastFallback.toAgent} switched to ${lastFallback.toModel?.split('/').pop() ?? 'its fallback model'}` : `${lastFallback.fromAgent ?? 'An agent'} → ${lastFallback.toAgent}`}${lastFallback.reason !== undefined ? `: ${lastFallback.reason}` : ''}`
                : hint}
            </span>
          </span>
          {summary.measures.length > 0 ? (
            <span className="measures hidden w-28 shrink-0 sm:flex" role="img" aria-label={`${summary.succeeded} of ${summary.total} tasks done`}>
              {summary.measures.map((measure) => <span key={measure.id} data-state={measure.state} title={measure.title} />)}
            </span>
          ) : null}
          <ChevronRightIcon size={13} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        </button>
        {open ? (
          <div id="pinned-plan-tasks" className="max-h-[46dvh] overflow-y-auto border-t border-border px-3.5 pb-3.5">
            <PlanCard task={task} details={details} embedded />
          </div>
        ) : null}
      </div>
    </section>
  );
}
