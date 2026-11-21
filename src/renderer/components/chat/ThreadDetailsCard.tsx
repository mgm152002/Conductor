import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStep, Workspace } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import type { PlanTask } from '@shared/plan';
import { useWorkspaceChanges } from '../../hooks/useWorkspaceChanges';
import { useUiStore } from '../../stores';
import { isWorkingState } from '../../lib/thread-status';
import { stepFallbacks } from '../../lib/timeline';
import { formatDuration } from '../../lib/time';
import { agentLabel } from '../../lib/usage-format';
import { cn } from '../../lib/cn';
import { BotIcon, ChevronDownIcon, ChevronRightIcon, GitBranchIcon, LayersIcon, MonitorIcon, Spinner } from '../ui/icons';
import { Dialog } from '../ui/primitives';
import { AgentMark } from './AgentMark';
import { PlanTaskRow, STATUS, agentChain } from './PlanCard';

// The thread details card: a small glass card floating at
// the top right of a thread. It says where the thread runs (this Mac, its
// branch and changes) and, for a planned thread, lists the plan's tasks as
// subagents — one 32px row each, grouped by wave. A row opens that task's
// details and work log in a dialog.

/** Panel row: 32px, soft hover fill, icon then label. */
const ROW = 'flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-foreground/80 transition-colors hover:bg-black/[0.035] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring dark:hover:bg-white/[0.08]';

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-label={title} className="border-border/65 px-2 pt-2 pb-2.5 not-first:border-t">
      <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-2.5">
        <h3 className="truncate text-2xs font-medium text-muted-foreground select-none">{title}</h3>
        {aside !== undefined ? <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function SubagentRow({ planTask, step, details, onOpen }: { planTask: PlanTask; step: TaskStep | undefined; details: TaskDetails; onOpen: () => void }): React.JSX.Element {
  const statusKey = step?.status ?? 'pending';
  const fallbacks = useMemo(() => step === undefined ? [] : stepFallbacks(details.events, step.id), [step, details.events]);
  const chain = agentChain(step, planTask.agent, fallbacks);
  const current = chain[chain.length - 1]!;
  const duration = step?.startedAt !== undefined && step.endedAt !== undefined ? formatDuration(Date.parse(step.endedAt) - Date.parse(step.startedAt)) : undefined;
  const meta = statusKey === 'succeeded' ? duration ?? STATUS[statusKey].label : STATUS[statusKey].label;
  return (
    <li>
      <button type="button" onClick={onOpen} disabled={step === undefined}
        title={`${planTask.title}\n${chain.map((entry) => `${entry.name}${entry.model !== undefined ? ` · ${entry.model}` : ''}`).join(' → ')}`}
        className={cn(ROW, 'group cursor-pointer disabled:cursor-default disabled:hover:bg-transparent')}>
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          {statusKey === 'running' ? <Spinner size={14} className="text-info" /> : <AgentMark agentId={current.agentId} name={current.name} size={16} />}
          {statusKey === 'failed' ? <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-destructive ring-2 ring-popover" /> : null}
          {fallbacks.length > 0 && statusKey !== 'failed' ? <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-warning ring-2 ring-popover" /> : null}
        </span>
        <span className={cn('min-w-0 flex-1 truncate leading-4', statusKey === 'pending' || statusKey === 'skipped' || statusKey === 'cancelled' ? 'text-muted-foreground' : 'text-foreground/85')}>{planTask.title}</span>
        <span className={cn('shrink-0 text-2xs font-normal tabular-nums', statusKey === 'failed' ? 'text-destructive-foreground' : 'text-muted-foreground')}>{meta}</span>
      </button>
    </li>
  );
}

function WaveGroup({ index, total, count, done, failed, live, children }: { index: number; total: number; count: number; done: number; failed: number; live: boolean; children: React.ReactNode }): React.JSX.Element {
  const [expanded, setExpanded] = useState(live || failed > 0 || total === 1);
  return (
    <div>
      {total > 1 ? (
        <button type="button" aria-expanded={expanded} onClick={() => { setExpanded((v) => !v); }} className={cn(ROW, 'cursor-pointer')}>
          {live ? <Spinner size={14} className="shrink-0 text-info" /> : <BotIcon size={16} className="shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">Wave {index + 1}</span>
          {failed > 0 ? <span className="shrink-0 text-2xs font-normal text-destructive-foreground">{failed} failed</span> : null}
          {!expanded ? <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">{done}/{count}</span> : null}
          <ChevronDownIcon size={14} className={cn('shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90')} />
        </button>
      ) : null}
      {expanded ? <ul className="m-0 flex list-none flex-col p-0">{children}</ul> : null}
    </div>
  );
}

export function ThreadDetailsCard({ task, project, details, className }: { task: Task; project: Workspace | undefined; details: TaskDetails | null; className?: string }): React.JSX.Element | null {
  const openDetails = useUiStore((s) => s.openDetails);
  const { changes } = useWorkspaceChanges(project?.id ?? null, task.updatedAt, isWorkingState(task.state), task.id);
  const [opened, setOpened] = useState<string | null>(null);
  if (project === undefined) return null;
  const additions = changes?.files.reduce((sum, f) => sum + (f.additions ?? 0), 0) ?? 0;
  const deletions = changes?.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0;
  const branch = changes?.branch ?? `conductor/${(task.threadId ?? task.id).slice(0, 8)}`;

  const plan = details?.plan ?? null;
  const planTasks = new Map((plan?.plan?.groups.flatMap((g) => g.tasks) ?? []).map((t) => [t.id, t]));
  const steps = new Map((details?.steps ?? []).map((s) => [s.id, s]));
  const stepFor = (id: string): TaskStep | undefined => steps.get(plan?.steps?.[id] ?? '');
  const waves = plan?.waves ?? [];
  const allIds = waves.flatMap((w) => w.tasks);
  const doneCount = allIds.filter((id) => stepFor(id)?.status === 'succeeded').length;
  const openTask = opened !== null ? planTasks.get(opened) : undefined;

  return (
    <aside aria-label="Thread details" className={cn('w-[280px]', className)}>
      <div className="dropdown-glass isolate flex max-h-[calc(100vh-140px)] flex-col overflow-hidden rounded-2xl shadow-lg/5">
        <div className="min-h-0 overflow-y-auto">
          <Section title="Environment">
            <div className={ROW} title="This thread runs on this Mac"><MonitorIcon size={16} className="shrink-0 text-muted-foreground" /><span className="truncate">This Mac</span></div>
            <div className={ROW} title={branch}>
              <GitBranchIcon size={16} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch}</span>
              {changes?.worktree === true ? <span className="shrink-0 text-2xs font-normal text-muted-foreground">worktree</span> : null}
            </div>
            <button type="button" onClick={() => { openDetails('files'); }} className={cn(ROW, 'cursor-pointer')} title="Open changed files and diffs">
              <LayersIcon size={16} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Changes</span>
              <span className="shrink-0 font-mono text-2xs font-normal tabular-nums"><span className="text-success">+{additions.toLocaleString()}</span> <span className="text-destructive-foreground">−{deletions.toLocaleString()}</span></span>
              <ChevronRightIcon size={12} className="shrink-0 text-muted-foreground" />
            </button>
          </Section>

          {plan !== null ? (
            <Section title="Subagents" aside={plan.plan !== undefined ? `${doneCount}/${allIds.length}` : undefined}>
              {plan.plan === undefined ? (
                <div className={cn(ROW, 'text-muted-foreground hover:bg-transparent')}>
                  {plan.status === 'failed' ? <BotIcon size={16} className="shrink-0 text-destructive" /> : <Spinner size={14} className="shrink-0 text-info" />}
                  <span className="truncate font-normal">{plan.status === 'failed' ? `${agentLabel(plan.plannerAdapterId)} could not write the plan` : `${agentLabel(plan.plannerAdapterId)} is planning…`}</span>
                </div>
              ) : waves.map((wave, index) => {
                const waveSteps = wave.tasks.map(stepFor);
                return (
                  <WaveGroup key={wave.id} index={index} total={waves.length} count={wave.tasks.length}
                    done={waveSteps.filter((s) => s?.status === 'succeeded').length}
                    failed={waveSteps.filter((s) => s?.status === 'failed').length}
                    live={waveSteps.some((s) => s?.status === 'running')}>
                    {wave.tasks.map((id) => {
                      const planTask = planTasks.get(id);
                      return planTask !== undefined && details !== null
                        ? <SubagentRow key={id} planTask={planTask} step={stepFor(id)} details={details} onOpen={() => { setOpened(id); }} />
                        : null;
                    })}
                  </WaveGroup>
                );
              })}
            </Section>
          ) : null}
        </div>
      </div>
      {openTask !== undefined && details !== null ? (
        <Dialog open onClose={() => { setOpened(null); }} title={openTask.title} description={plan?.plan?.title} width="max-w-2xl">
          <ul className="-mx-2 max-h-[65vh] overflow-y-auto">
            <PlanTaskRow task={task} planTask={openTask} step={stepFor(openTask.id)} details={details} defaultOpen />
          </ul>
        </Dialog>
      ) : null}
    </aside>
  );
}

/**
 * Where the card goes: pinned at the top right when the
 * thread is wide enough to keep the chat clear of it, otherwise a small glass
 * button there that opens the same card over the chat.
 */
export function ThreadDetailsFloat({ task, project, details }: { task: Task; project: Workspace | undefined; details: TaskDetails | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [task.id]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      // A subagent's dialog is portalled outside; clicks in it keep the card open.
      if (target?.closest('[role="dialog"]') !== null && target?.closest('[role="dialog"]') !== undefined) return;
      if (box.current !== null && !box.current.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && document.querySelector('[role="dialog"]') === null) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (project === undefined) return null;
  const plan = details?.plan ?? null;
  const ids = plan?.waves?.flatMap((w) => w.tasks) ?? [];
  const stepIds = new Set(ids.map((id) => plan?.steps?.[id]).filter((id): id is string => id !== undefined));
  const done = (details?.steps ?? []).filter((s) => stepIds.has(s.id) && s.status === 'succeeded').length;
  const live = (details?.steps ?? []).some((s) => stepIds.has(s.id) && s.status === 'running');
  return (
    <>
      <ThreadDetailsCard task={task} project={project} details={details} className="absolute top-[64px] right-3 z-20 hidden @min-[60rem]:block" />
      <div ref={box} className="absolute top-[64px] right-3 z-20 flex flex-col items-end gap-2 @min-[60rem]:hidden">
        <button type="button" aria-expanded={open} aria-label="Thread details" onClick={() => { setOpen((v) => !v); }}
          className="dropdown-glass flex h-8 cursor-pointer items-center gap-2 rounded-full px-3 text-[13px] font-medium text-foreground/80 shadow-lg/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          {live ? <Spinner size={13} className="text-info" /> : plan !== null ? <BotIcon size={15} className="text-muted-foreground" /> : <MonitorIcon size={15} className="text-muted-foreground" />}
          {plan !== null && ids.length > 0 ? <>Subagents <span className="text-xs font-normal text-muted-foreground tabular-nums">{done}/{ids.length}</span></> : 'Details'}
          <ChevronDownIcon size={13} className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>
        {open ? <ThreadDetailsCard task={task} project={project} details={details} /> : null}
      </div>
    </>
  );
}
