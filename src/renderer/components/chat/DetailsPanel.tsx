import { useEffect } from 'react';
import type { Task } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { useUiStore, type DetailsTab } from '../../stores/ui-store';
import { cn } from '../../lib/cn';
import { Button } from '../ui/primitives';
import { XIcon } from '../ui/icons';
import { PlanTimelineRegion } from '../workspace/PlanTimelineRegion';
import { VerificationRegion } from '../workspace/VerificationRegion';
import { FilesRegion } from '../workspace/FilesRegion';
import { ContextPanelRegion } from '../workspace/ContextPanelRegion';
import { ActivityRegion } from '../workspace/ActivityRegion';

const TABS: { id: DetailsTab; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'checks', label: 'Checks' },
  { id: 'files', label: 'Files' },
  { id: 'context', label: 'Context' },
  { id: 'activity', label: 'Log' },
];

/** Right-hand thread inspector: plan, verification, artifacts, context and raw log. */
export function DetailsPanel({ task, details, embedded = false }: { task: Task; details: TaskDetails | null; embedded?: boolean }): React.JSX.Element {
  const tab = useUiStore((s) => s.detailsTab);
  const openDetails = useUiStore((s) => s.openDetails);
  const setOpen = useUiStore((s) => s.setDetailsOpen);
  useEffect(() => {
    if (embedded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [embedded, setOpen]);
  const counts: Partial<Record<DetailsTab, number>> = {
    plan: details?.steps.length ?? 0,
    context: task.contextRefs.length,
  };
  return (
    <aside aria-label="Thread details" className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', embedded ? 'w-full' : 'thread-details border-l border-border')}>
      <div className="app-drag flex h-(--topbar-height) shrink-0 items-center gap-1 border-b border-border px-2">
        <div role="tablist" aria-label="Details" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${embedded ? 'work' : 'chat'}-details-${item.id}`}
              aria-controls={`${embedded ? 'work' : 'chat'}-details-content`}
              aria-selected={tab === item.id}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => { openDetails(item.id); }}
              onKeyDown={(event) => {
                const index = TABS.findIndex((candidate) => candidate.id === item.id);
                const nextIndex = event.key === 'ArrowRight' ? (index + 1) % TABS.length
                  : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : undefined;
                if (nextIndex === undefined) return;
                event.preventDefault();
                const next = TABS[nextIndex]!;
                openDetails(next.id);
                document.getElementById(`${embedded ? 'work' : 'chat'}-details-${next.id}`)?.focus();
              }}
              className={cn(
                'flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                tab === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
              {(counts[item.id] ?? 0) > 0 ? <span className="text-3xs text-muted-foreground tabular-nums">{counts[item.id]}</span> : null}
            </button>
          ))}
        </div>
        {!embedded ? <Button size="icon-sm" variant="ghost" aria-label="Close details" onClick={() => { setOpen(false); }}><XIcon size={13} /></Button> : null}
      </div>
      <div role="tabpanel" id={`${embedded ? 'work' : 'chat'}-details-content`} aria-labelledby={`${embedded ? 'work' : 'chat'}-details-${tab}`} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 [overflow-wrap:anywhere]">
        {tab === 'plan' ? <PlanTimelineRegion task={task} details={details} /> : null}
        {tab === 'checks' ? <VerificationRegion task={task} details={details} /> : null}
        {tab === 'files' ? <FilesRegion task={task} details={details} /> : null}
        {tab === 'context' ? <ContextPanelRegion task={task} /> : null}
        {tab === 'activity' ? <ActivityRegion details={details} /> : null}
      </div>
    </aside>
  );
}
