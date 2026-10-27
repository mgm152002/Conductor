import { useMemo, useState } from 'react';
import type { Task, TaskStep } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import type { PlanTask } from '@shared/plan';
import { buildTimeline, recentActivities } from '../../lib/timeline';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/time';
import { agentLabel, usageLabel } from '../../lib/usage-format';
import { useWorkspaceStore } from '../../stores';
import { ChevronRightIcon, FileTextIcon, LayersIcon, Spinner } from '../ui/icons';
import { MessagesTimeline } from './MessagesTimeline';
import { WorkIcon } from './WorkIcon';

// Plan mode: the plan the planner agent wrote, as waves of tasks. Tasks in a
// wave have no dependencies on each other and run in parallel; each row shows
// its agent, status and tokens, and expands to that agent's own work log.

const STATUS: Record<TaskStep['status'], { label: string; dot: string }> = {
  pending: { label: 'Waiting', dot: 'bg-muted-foreground/40' },
  running: { label: 'Running', dot: 'bg-sky-500 animate-status-pulse' },
  succeeded: { label: 'Done', dot: 'bg-success' },
  failed: { label: 'Failed', dot: 'bg-destructive' },
  skipped: { label: 'Skipped', dot: 'bg-muted-foreground/30' },
  cancelled: { label: 'Stopped', dot: 'bg-muted-foreground/40' },
};

function PlanTaskRow({ task, planTask, step, details }: { task: Task; planTask: PlanTask; step: TaskStep | undefined; details: TaskDetails }): React.JSX.Element {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const status = STATUS[step?.status ?? 'pending'];
  const usage = step !== undefined ? details.usage?.byStep[step.id] : undefined;
  const events = useMemo(
    () => step === undefined ? [] : details.events.filter((e) => e.stepId === step.id && e.kind !== 'transition'),
    [step, details],
  );
  const timeline = useMemo(
    () => step === undefined ? [] : buildTimeline(task, { ...details, events }).filter((item) => item.kind !== 'user'),
    [events, step, details, task],
  );
  const activity = useMemo(() => recentActivities(timeline, 4), [timeline]);
  // A running plan task is expanded so the thread shows what the agent is
  // doing live, not just the plan row's status dot.
  const running = step?.status === 'running';
  const open = manualOpen ?? running;
  const items = open ? timeline : [];
  const duration = step?.startedAt !== undefined && step.endedAt !== undefined ? formatDuration(Date.parse(step.endedAt) - Date.parse(step.startedAt)) : undefined;
  return (
    <li className="rounded-lg border border-border/70 bg-background/60">
      <button
        type="button"
        onClick={() => { setManualOpen(!open); }}
        aria-expanded={open}
        disabled={step === undefined}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent/60 disabled:cursor-default"
      >
        <ChevronRightIcon size={11} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90', step === undefined && 'opacity-0')} />
        <span className={cn('size-1.5 shrink-0 rounded-full', status.dot)} aria-hidden="true" />
        <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{planTask.id}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">{planTask.title}</span>
        <span className="max-w-32 shrink truncate text-3xs text-muted-foreground" title={runLabel(step) ?? 'Agent default model'}>
          {agentLabel(step?.assignedAdapterId ?? planTask.agent)}{step?.run?.model ? ` · ${step.run.model}` : ''}{step?.run?.effort ? ` · ${step.run.effort}` : ''}
        </span>
        <span className="w-14 shrink-0 text-right text-3xs text-muted-foreground">{status.label}</span>
        <span className="hidden w-28 shrink-0 text-right text-3xs text-muted-foreground tabular-nums sm:inline">
          {[duration, usage !== undefined ? usageLabel(usage).replace(' tokens', ' tok') : undefined].filter(Boolean).join(' · ')}
        </span>
      </button>
      {!open && activity.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-0.5 px-8 pb-1.5" aria-label="Recent activity">
          {activity.map((entry, index) => {
            const latest = index === activity.length - 1;
            return (
              <li key={entry.id} className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
                {running && latest ? <Spinner size={9} className="shrink-0 text-info" /> : <WorkIcon icon={entry.icon} size={9} className="shrink-0" />}
                {entry.source !== undefined ? <span className="shrink-0 text-muted-foreground/70">{entry.source}</span> : null}
                <span className={cn('truncate', entry.tone === 'error' ? 'text-destructive-foreground' : running && latest ? 'text-shimmer' : '')} title={entry.detail ?? entry.label}>{entry.label}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!open && activity.length === 0 && running ? (
        <p className="flex items-center gap-1.5 px-8 pb-1.5 text-3xs text-muted-foreground"><Spinner size={9} className="shrink-0 text-info" />Starting…</p>
      ) : null}
      {open ? (
        <div className="border-t border-border/70 px-3 py-2.5">
          {planTask.details.length > 0 ? (
            <ul className="mb-2 list-disc pl-4 text-2xs text-muted-foreground">
              {planTask.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          ) : null}
          {planTask.dependsOn.length > 0 ? <p className="mb-2 text-3xs text-muted-foreground">Depends on {planTask.dependsOn.join(', ')}</p> : null}
          {items.length > 0 ? <MessagesTimeline items={items} live={running} /> : <p className="text-2xs text-muted-foreground">{step?.status === 'pending' ? 'Not started yet.' : 'No output recorded.'}</p>}
        </div>
      ) : null}
    </li>
  );
}

/** "gpt-5.6-luna · low" — what a step's agent ran with. */
export function runLabel(step: TaskStep | undefined): string | undefined {
  const run = step?.run;
  if (run === undefined) return undefined;
  const parts = [run.model, run.effort !== undefined ? `${run.effort} effort` : undefined].filter((p): p is string => p !== undefined);
  if (parts.length === 0) return undefined;
  return `${parts.join(' · ')}${run.source === 'auto' ? ' (auto)' : ''}`;
}

/** Each plan task's reply, in wave order, shown in the conversation. */
export function PlanResults({ task, details }: { task: Task; details: TaskDetails }): React.JSX.Element | null {
  const plan = details.plan;
  const sections = useMemo(() => {
    if (plan?.plan === undefined || plan.waves === undefined) return [];
    const planTasks = new Map(plan.plan.groups.flatMap((g) => g.tasks).map((t) => [t.id, t]));
    const steps = new Map(details.steps.map((s) => [s.id, s]));
    return plan.waves.flatMap((w) => w.tasks).flatMap((id) => {
      const step = steps.get(plan.steps?.[id] ?? '');
      if (step === undefined) return [];
      const events = details.events.filter((e) => e.stepId === step.id && e.kind !== 'transition');
      // The agent's final reply: its last assistant message, plus any error.
      const items = buildTimeline(task, { ...details, events }).filter((item) => item.kind === 'assistant' || item.kind === 'error');
      const lastReply = [...items].reverse().find((item) => item.kind === 'assistant');
      const shown = items.filter((item) => item.kind === 'error' || item === lastReply);
      return shown.length > 0 ? [{ id, title: planTasks.get(id)?.title ?? step.description, step, items: shown }] : [];
    });
  }, [plan, details, task]);
  if (sections.length === 0) return null;
  const single = sections.length === 1;
  return (
    <div className="flex flex-col gap-4" aria-label="Plan results">
      {sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-1.5">
          {!single ? (
            <p className="flex items-center gap-1.5 px-1 text-2xs text-muted-foreground">
              <span className="font-mono tabular-nums">{section.id}</span>
              <span className="font-medium text-foreground">{section.title}</span>
              <span>· {agentLabel(section.step.assignedAdapterId)}</span>
            </p>
          ) : null}
          <MessagesTimeline items={section.items} live={false} />
        </div>
      ))}
    </div>
  );
}

export function PlanCard({ task, details, embedded = false }: { task: Task; details: TaskDetails; embedded?: boolean }): React.JSX.Element | null {
  const plan = details.plan;
  const project = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === task.workspaceId));
  if (plan === null || plan === undefined) return null;
  const planner = agentLabel(plan.plannerAdapterId);

  if (plan.plan === undefined) {
    return (
      <section aria-label="Plan" className={cn('text-xs', embedded ? '' : 'rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3')}>
        <div className="flex items-center gap-2 text-muted-foreground">
          <LayersIcon size={13} />
          {plan.status === 'failed'
            ? <span className="text-destructive-foreground">{planner} could not write a plan{plan.error ? `: ${plan.error}` : '.'}</span>
            : <><Spinner size={12} /><span className="text-shimmer">{planner} is writing the plan…</span></>}
        </div>
      </section>
    );
  }

  const tasks = new Map(plan.plan.groups.flatMap((g) => g.tasks).map((t) => [t.id, t]));
  const steps = new Map(details.steps.map((s) => [s.id, s]));
  const stepFor = (planTaskId: string): TaskStep | undefined => steps.get(plan.steps?.[planTaskId] ?? '');
  const done = details.steps.filter((s) => s.status === 'succeeded').length;
  const docs = plan.docsDir !== undefined && project !== undefined && plan.docsDir.startsWith(project.rootPath)
    ? plan.docsDir.slice(project.rootPath.length + 1) : plan.docsDir;

  return (
    <section aria-label="Plan" className={cn('flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]', !embedded && 'rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3')}>
      <header className="flex flex-col gap-1">
        {!embedded ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <LayersIcon size={13} className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1 font-medium text-foreground">{plan.plan.title}</span>
            <span className="ml-auto shrink-0 text-3xs text-muted-foreground tabular-nums">{done}/{tasks.size} done · {plan.waves?.length ?? 0} wave{plan.waves?.length === 1 ? '' : 's'}</span>
          </div>
        ) : null}
        <p className="text-2xs text-muted-foreground">
          Planned by {planner}{plan.plannerRun?.model ? ` · ${plan.plannerRun.model}` : ''}{plan.plannerRun?.effort ? ` · ${plan.plannerRun.effort} effort` : ''}
          {details.usage?.byStep['planner'] ? ` (${usageLabel(details.usage.byStep['planner'])})` : ''}. Tasks in the same wave run in parallel; each task’s model follows its difficulty unless you chose one.
        </p>
        {docs !== undefined ? (
          <p className="flex items-center gap-1 text-3xs text-muted-foreground" title={plan.docsDir}>
            <FileTextIcon size={11} /><span className="truncate font-mono">{docs}/requirements.md, tasks.md</span>
          </p>
        ) : null}
      </header>
      <ol className="flex flex-col gap-2.5">
        {(plan.waves ?? []).map((wave) => (
          <li key={wave.id} className="flex flex-col gap-1">
            <p className="text-3xs font-medium tracking-wide text-muted-foreground uppercase">
              Wave {wave.id}{wave.tasks.length > 1 ? ` · ${wave.tasks.length} in parallel` : ''}
            </p>
            <ul className="flex flex-col gap-1">
              {wave.tasks.map((id) => {
                const planTask = tasks.get(id);
                return planTask !== undefined ? <PlanTaskRow key={id} task={task} planTask={planTask} step={stepFor(id)} details={details} /> : null;
              })}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
