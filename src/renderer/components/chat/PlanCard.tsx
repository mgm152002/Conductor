import { useMemo, useState } from 'react';
import type { Task, TaskStep } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import type { PlanTask } from '@shared/plan';
import { buildTimeline, recentActivities, stepFallbacks, type StepFallback } from '../../lib/timeline';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/time';
import { agentLabel, usageLabel } from '../../lib/usage-format';
import { useWorkspaceStore } from '../../stores';
import { AlertCircleIcon, CheckIcon, ChevronRightIcon, FileTextIcon, LayersIcon, RotateIcon, Spinner, XIcon } from '../ui/icons';
import { AgentMark } from './AgentMark';
import { MessagesTimeline } from './MessagesTimeline';
import { WorkIcon } from './WorkIcon';

// Plan mode: the plan the planner agent wrote, as a vertical run of waves.
// Tasks in one wave have no dependencies on each other and run in parallel,
// so each wave is one numbered stop on the rail with its tasks beside it.
// A task row leads with its status, then its title, then who ran it — and
// when Conductor had to fall back (quota, unsupported model) that agent
// chain is spelled out on the row ("Codex → OpenCode") with the reason, so
// a fallback is never hidden inside a collapsed log.

const STATUS: Record<TaskStep['status'], { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'text-muted-foreground' },
  running: { label: 'Running', tone: 'text-sky-600 dark:text-sky-300' },
  succeeded: { label: 'Done', tone: 'text-success' },
  failed: { label: 'Failed', tone: 'text-destructive-foreground' },
  skipped: { label: 'Skipped', tone: 'text-muted-foreground' },
  cancelled: { label: 'Stopped', tone: 'text-muted-foreground' },
};

function StatusGlyph({ status }: { status: TaskStep['status'] }): React.JSX.Element {
  const base = 'flex size-5 shrink-0 items-center justify-center rounded-full';
  switch (status) {
    case 'succeeded': return <span className={cn(base, 'bg-success/15 text-success')}><CheckIcon size={11} /></span>;
    case 'failed': return <span className={cn(base, 'bg-destructive/12 text-destructive-foreground')}><XIcon size={11} /></span>;
    case 'running': return <span className={cn(base, 'bg-sky-500/15 text-sky-600 dark:text-sky-300')}><Spinner size={11} /></span>;
    case 'skipped':
    case 'cancelled': return <span className={cn(base, 'border border-dashed border-border-strong')} />;
    default: return <span className={cn(base, 'border border-border-strong')} />;
  }
}

const shortModel = (model: string | undefined): string | undefined => model?.split('/').pop();

/**
 * The agent chain for a step: every CLI (and model) it ran on, in order,
 * ending at the one that holds it now. One entry when there was no fallback.
 */
function agentChain(step: TaskStep | undefined, planAgent: string, fallbacks: readonly StepFallback[]): Array<{ agentId: string; name: string; model?: string | undefined }> {
  if (fallbacks.length === 0) {
    const id = step?.assignedAdapterId ?? planAgent;
    return [{ agentId: id, name: agentLabel(id), model: shortModel(step?.run?.model) }];
  }
  const first = fallbacks[0]!;
  const chain = [{ agentId: first.fromAgentId ?? planAgent, name: first.fromAgent ?? agentLabel(first.fromAgentId ?? planAgent), model: shortModel(first.fromModel) }];
  for (const fallback of fallbacks) chain.push({ agentId: fallback.toAgentId, name: fallback.toAgent, model: shortModel(fallback.toModel) });
  return chain;
}

/** "Codex · gpt-6 → OpenCode" with each agent's mark; the last one is current. */
function AgentChain({ chain, compact = false }: { chain: ReturnType<typeof agentChain>; compact?: boolean }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
      {chain.map((entry, index) => {
        const last = index === chain.length - 1;
        return (
          <span key={`${entry.agentId}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <span aria-hidden="true" className="text-muted-foreground/70">→</span> : null}
            <AgentMark agentId={entry.agentId} name={entry.name} size={14} />
            <span className={cn('truncate', last ? 'font-medium text-foreground/85' : 'line-through decoration-muted-foreground/50')}>
              {entry.name}{!compact && entry.model !== undefined ? ` · ${entry.model}` : ''}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function PlanTaskRow({ task, planTask, step, details }: { task: Task; planTask: PlanTask; step: TaskStep | undefined; details: TaskDetails }): React.JSX.Element {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const statusKey = step?.status ?? 'pending';
  const status = STATUS[statusKey];
  const usage = step !== undefined ? details.usage?.byStep[step.id] : undefined;
  const fallbacks = useMemo(() => step === undefined ? [] : stepFallbacks(details.events, step.id), [step, details.events]);
  const chain = useMemo(() => agentChain(step, planTask.agent, fallbacks), [step, planTask.agent, fallbacks]);
  const events = useMemo(
    () => step === undefined ? [] : details.events.filter((e) => e.stepId === step.id && e.kind !== 'transition'),
    [step, details],
  );
  const timeline = useMemo(
    () => step === undefined ? [] : buildTimeline(task, { ...details, events }).filter((item) => item.kind !== 'user'),
    [events, step, details, task],
  );
  const activity = useMemo(() => recentActivities(timeline, 3), [timeline]);
  // A running plan task is expanded so the thread shows what the agent is
  // doing live, not just the row's status.
  const running = statusKey === 'running';
  const open = manualOpen ?? running;
  // The fallbacks are on the row itself; the expanded log keeps the rest.
  const items = open ? timeline.filter((item) => item.kind !== 'handoff') : [];
  const duration = step?.startedAt !== undefined && step.endedAt !== undefined ? formatDuration(Date.parse(step.endedAt) - Date.parse(step.startedAt)) : undefined;
  const latestFallback = fallbacks[fallbacks.length - 1];
  return (
    <li className={cn('rounded-xl border bg-card transition-colors', running ? 'border-sky-500/35' : statusKey === 'failed' ? 'border-destructive/30' : 'border-border')}>
      <button
        type="button"
        onClick={() => { setManualOpen(!open); }}
        aria-expanded={open}
        disabled={step === undefined}
        className="flex w-full cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="mt-px"><StatusGlyph status={statusKey} /></span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{planTask.id}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={planTask.title}>{planTask.title}</span>
            <span className={cn('shrink-0 text-2xs font-medium', status.tone)}>{status.label}</span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="min-w-0" title={runLabel(step) ?? 'Agent default model'}><AgentChain chain={chain} /></span>
            {fallbacks.length > 0 ? (
              <span
                className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/12 px-1.5 py-px text-3xs font-medium text-amber-700 dark:text-amber-300"
                title={fallbacks.map((f) => f.reason ?? (f.kind === 'model' ? `${f.toAgent} retried on its fallback model` : `${f.toAgent} took over`)).join('\n')}
              >
                <RotateIcon size={9} />
                {fallbacks.length === 1 ? (fallbacks[0]!.kind === 'model' ? 'Fallback model' : 'Fallback') : `${fallbacks.length} fallbacks`}
              </span>
            ) : null}
            {duration !== undefined || usage !== undefined ? (
              <span className="ml-auto shrink-0 text-3xs text-muted-foreground tabular-nums">
                {[duration, usage !== undefined ? usageLabel(usage).replace(' tokens', ' tok') : undefined].filter(Boolean).join(', ')}
              </span>
            ) : null}
          </span>
          {latestFallback?.reason !== undefined ? (
            <span className="flex min-w-0 items-start gap-1 text-3xs leading-snug text-amber-700/90 dark:text-amber-300/80">
              <AlertCircleIcon size={10} className="mt-px shrink-0" />
              <span className="min-w-0">{latestFallback.reason}{latestFallback.kind === 'agent' ? `, so ${latestFallback.toAgent} took over.` : `, so it retried on ${shortModel(latestFallback.toModel) ?? 'its fallback model'}.`}</span>
            </span>
          ) : null}
        </span>
        <ChevronRightIcon size={12} className={cn('mt-1 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90', step === undefined && 'opacity-0')} />
      </button>
      {!open && activity.length > 0 && running ? (
        <ul className="flex min-w-0 flex-col gap-0.5 px-3 pb-2.5 pl-[42px]" aria-label="Recent activity">
          {activity.map((entry, index) => {
            const latest = index === activity.length - 1;
            return (
              <li key={entry.id} className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
                {latest ? <Spinner size={9} className="shrink-0 text-info" /> : <WorkIcon icon={entry.icon} size={9} className="shrink-0" />}
                <span className={cn('truncate', entry.tone === 'error' ? 'text-destructive-foreground' : latest ? 'text-shimmer' : '')} title={entry.detail ?? entry.label}>{entry.label}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!open && activity.length === 0 && running ? (
        <p className="flex items-center gap-1.5 px-3 pb-2.5 pl-[42px] text-3xs text-muted-foreground"><Spinner size={9} className="shrink-0 text-info" />Starting…</p>
      ) : null}
      {open ? (
        <div className="mx-3 mb-3 ml-[42px] flex flex-col gap-2 border-t border-border pt-2.5">
          {planTask.details.length > 0 ? (
            <ul className="list-disc pl-4 text-2xs leading-relaxed text-muted-foreground">
              {planTask.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          ) : null}
          {planTask.dependsOn.length > 0 ? <p className="text-3xs text-muted-foreground">Waits for {planTask.dependsOn.join(', ')}</p> : null}
          {items.length > 0 ? <MessagesTimeline items={items} live={running} /> : <p className="text-2xs text-muted-foreground">{statusKey === 'pending' ? 'Not started yet.' : 'No output recorded.'}</p>}
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
      const planTask = planTasks.get(id);
      const chain = agentChain(step, planTask?.agent ?? step.assignedAdapterId ?? '', stepFallbacks(details.events, step.id));
      return shown.length > 0 ? [{ id, title: planTask?.title ?? step.description, step, chain, items: shown }] : [];
    });
  }, [plan, details, task]);
  if (sections.length === 0) return null;
  const single = sections.length === 1;
  return (
    <div className="flex flex-col gap-4" aria-label="Plan results">
      {sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-1.5">
          {!single || section.chain.length > 1 ? (
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-1 text-2xs text-muted-foreground">
              <span className="font-mono tabular-nums">{section.id}</span>
              <span className="font-medium text-foreground">{section.title}</span>
              <AgentChain chain={section.chain} compact />
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
      <section aria-label="Plan" className={cn('text-xs', embedded ? '' : 'group-card px-3.5 py-3')}>
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
    <section aria-label="Plan" className={cn('min-w-0 [overflow-wrap:anywhere]', !embedded && 'group-card overflow-hidden')}>
      <header className={cn('flex flex-col gap-0.5', !embedded && 'px-3.5 pt-3 pb-2')}>
        {!embedded ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <LayersIcon size={13} className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{plan.plan.title}</span>
            <span className="ml-auto shrink-0 rounded-full bg-accent px-2 py-0.5 text-3xs font-medium text-muted-foreground tabular-nums">{done}/{tasks.size} done</span>
          </div>
        ) : null}
        <p className="truncate text-2xs text-muted-foreground" title={`Planned by ${planner}`}>
          Planned by {planner}{plan.plannerRun?.model ? ` · ${plan.plannerRun.model}` : ''}{plan.plannerRun?.effort ? ` · ${plan.plannerRun.effort} effort` : ''}
          {details.usage?.byStep['planner'] ? ` (${usageLabel(details.usage.byStep['planner'])})` : ''}
        </p>
        {docs !== undefined ? (
          <p className="flex items-center gap-1 text-3xs text-muted-foreground" title={plan.docsDir}>
            <FileTextIcon size={11} /><span className="truncate font-mono">{docs}/requirements.md, tasks.md</span>
          </p>
        ) : null}
      </header>
      <ol className={cn('flex flex-col', !embedded && 'px-3.5 pb-3.5')}>
        {(plan.waves ?? []).map((wave, index, waves) => {
          const waveSteps = wave.tasks.map(stepFor);
          const waveDone = waveSteps.length > 0 && waveSteps.every((s) => s?.status === 'succeeded');
          const waveLive = waveSteps.some((s) => s?.status === 'running');
          const waveFailed = waveSteps.some((s) => s?.status === 'failed');
          return (
            <li key={wave.id} className="relative flex gap-3 pt-3">
              {/* The rail: one numbered stop per wave, joined by a line. */}
              <span aria-hidden="true" className="relative flex w-6 shrink-0 flex-col items-center">
                <span className={cn(
                  'z-10 flex size-6 items-center justify-center rounded-full text-3xs font-semibold tabular-nums',
                  waveDone ? 'bg-success text-white' : waveFailed ? 'bg-destructive text-white' : waveLive ? 'bg-primary text-primary-foreground' : 'border border-border-strong bg-background text-muted-foreground',
                )}>
                  {waveDone ? <CheckIcon size={12} /> : index + 1}
                </span>
                {index < waves.length - 1 ? <span className={cn('absolute top-6 -bottom-3 w-px', waveDone ? 'bg-success/50' : 'bg-border-strong')} /> : null}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="flex h-6 items-center gap-2 text-2xs font-medium text-muted-foreground">
                  <span className="text-foreground/85">Wave {index + 1}</span>
                  {wave.tasks.length > 1 ? <span>{wave.tasks.length} tasks in parallel</span> : null}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {wave.tasks.map((id) => {
                    const planTask = tasks.get(id);
                    return planTask !== undefined ? <PlanTaskRow key={id} task={task} planTask={planTask} step={stepFor(id)} details={details} /> : null;
                  })}
                </ul>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
