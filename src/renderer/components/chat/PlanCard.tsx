import { useMemo, useState } from 'react';
import type { Task, TaskStep } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import type { PlanTask } from '@shared/plan';
import { buildTimeline } from '../../lib/timeline';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/time';
import { agentLabel, usageLabel } from '../../lib/usage-format';
import { useWorkspaceStore } from '../../stores';
import { ChevronRightIcon, FileTextIcon, LayersIcon, Spinner } from '../ui/icons';
import { MessagesTimeline } from './MessagesTimeline';

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
  const [open, setOpen] = useState(false);
  const status = STATUS[step?.status ?? 'pending'];
  const usage = step !== undefined ? details.usage?.byStep[step.id] : undefined;
  const items = useMemo(() => {
    if (!open || step === undefined) return [];
    const events = details.events.filter((e) => e.stepId === step.id && e.kind !== 'transition');
    return buildTimeline(task, { ...details, events }).filter((item) => item.kind !== 'user');
  }, [open, step, details, task]);
  const duration = step?.startedAt !== undefined && step.endedAt !== undefined ? formatDuration(Date.parse(step.endedAt) - Date.parse(step.startedAt)) : undefined;
  return (
    <li className="rounded-lg border border-border/70 bg-background/60">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); }}
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
      {open ? (
        <div className="border-t border-border/70 px-3 py-2.5">
          {planTask.details.length > 0 ? (
            <ul className="mb-2 list-disc pl-4 text-2xs text-muted-foreground">
              {planTask.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          ) : null}
          {planTask.dependsOn.length > 0 ? <p className="mb-2 text-3xs text-muted-foreground">Depends on {planTask.dependsOn.join(', ')}</p> : null}
          {items.length > 0 ? <MessagesTimeline items={items} live={step?.status === 'running'} /> : <p className="text-2xs text-muted-foreground">{step?.status === 'pending' ? 'Not started yet.' : 'No output recorded.'}</p>}
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

export function PlanCard({ task, details }: { task: Task; details: TaskDetails }): React.JSX.Element | null {
  const plan = details.plan;
  const project = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === task.workspaceId));
  if (plan === null || plan === undefined) return null;
  const planner = agentLabel(plan.plannerAdapterId);

  if (plan.plan === undefined) {
    return (
      <section aria-label="Plan" className="rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3 text-xs">
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
    <section aria-label="Plan" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3 [overflow-wrap:anywhere]">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <LayersIcon size={13} className="shrink-0 text-primary" />
          <span className="min-w-0 flex-1 font-medium text-foreground">{plan.plan.title}</span>
          <span className="ml-auto shrink-0 text-3xs text-muted-foreground tabular-nums">{done}/{tasks.size} done · {plan.waves?.length ?? 0} wave{plan.waves?.length === 1 ? '' : 's'}</span>
        </div>
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
