import type { TaskDetails } from '@shared/task-view';
import { RegionCard } from './RegionCard';
import { eventLabel, eventText } from './task-event-format';

/** Raw event log for the task, newest first. */
export function ActivityRegion({ details }: { details: TaskDetails | null }): React.JSX.Element {
  const steps = (details?.steps ?? []).filter((step) => step.assignedAdapterId !== undefined);
  const events = [...(details?.events ?? [])].reverse();
  return (
    <RegionCard title="Agent & tool activity" count={events.length} {...(events.length >= 500 ? { subtitle: 'Latest 500 events' } : {})} emptyLabel="Execution events for the selected task appear here." isEmpty={steps.length === 0 && events.length === 0}>
      {steps.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-1.5">
          {steps.map((step) => (
            <li key={step.id} className="flex justify-between gap-2 text-xs">
              <span className="font-mono break-all text-foreground">{step.assignedAdapterId}<span className="block font-sans text-muted-foreground">{step.description}</span></span>
              <span className="text-muted-foreground">{step.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <ol className="flex flex-col gap-1.5">
        {events.map((event) => (
          <li key={event.id} className="rounded-lg border border-border px-2 py-1.5 text-2xs">
            <div className="flex justify-between gap-2 text-muted-foreground">
              <span className="font-medium">{eventLabel(event)}{event.stepId ? ` · step ${(details?.steps.find((step) => step.id === event.stepId)?.ordinal ?? -1) + 1 || event.stepId}` : ''}</span>
              <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString()}</time>
            </div>
            <pre className="mt-1 max-h-40 overflow-auto font-mono text-3xs leading-relaxed whitespace-pre-wrap break-words text-foreground/80">{eventText(event)}</pre>
          </li>
        ))}
      </ol>
    </RegionCard>
  );
}
