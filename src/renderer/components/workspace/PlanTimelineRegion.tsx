import type { Task, TaskStepStatus } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { cn } from '../../lib/cn';
import { RegionCard } from './RegionCard';

const STATUS_DOT: Record<TaskStepStatus, string> = {
  pending: 'border border-muted-foreground/50 bg-transparent',
  running: 'bg-sky-500 animate-status-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  skipped: 'bg-muted-foreground/40',
  cancelled: 'bg-muted-foreground/40',
};

export function PlanTimelineRegion({ task, details }: { task: Task | null; details: TaskDetails | null }): React.JSX.Element {
  const steps = [...(details?.steps ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <RegionCard title="Execution plan & timeline" count={steps.length} {...(task === null ? {} : { subtitle: task.state.toLowerCase().replace(/_/g, ' ') })} emptyLabel={task === null ? 'Select or start a task to inspect its plan.' : 'No execution steps have been recorded yet.'} isEmpty={steps.length === 0}>
      <ol className="relative flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.id} className="relative flex gap-3 text-xs">
            <div className="flex flex-col items-center pt-1">
              <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[step.status])} aria-hidden="true" />
              {index < steps.length - 1 ? <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" /> : null}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="min-w-0 flex-1 font-medium text-foreground">{step.ordinal + 1}. {step.description}</span>
                <span className={cn('shrink-0', step.status === 'failed' ? 'text-destructive-foreground' : 'text-muted-foreground')}>{step.status}</span>
              </div>
              {step.assignedAdapterId ? <p className="mt-1 text-muted-foreground">Agent / tool: <span className="font-mono">{step.assignedAdapterId}</span></p> : null}
              {step.dependsOn.length > 0 ? <p className="mt-1 text-muted-foreground">Depends on: {step.dependsOn.map((id) => { const dependency = steps.find((item) => item.id === id); return dependency ? `${dependency.ordinal + 1}. ${dependency.description}` : id; }).join('; ')}</p> : null}
              {step.startedAt ? <p className="mt-1 text-muted-foreground/80">Started <time dateTime={step.startedAt}>{new Date(step.startedAt).toLocaleString()}</time>{step.endedAt ? <> · Ended <time dateTime={step.endedAt}>{new Date(step.endedAt).toLocaleString()}</time></> : null}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </RegionCard>
  );
}
