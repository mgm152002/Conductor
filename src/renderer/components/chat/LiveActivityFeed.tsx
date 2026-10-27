import { useEffect, useMemo, useRef } from 'react';
import type { Task } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { buildTimeline, recentActivities } from '../../lib/timeline';
import { isWorkingState } from '../../lib/thread-status';
import { cn } from '../../lib/cn';
import { ActivityIcon, Spinner } from '../ui/icons';
import { WorkIcon } from './WorkIcon';

// A pinned, continuously updating tail of the focused task's CLI stream. It
// shows several recent steps (including plan tasks running in parallel)
// instead of reducing live work to the single latest-activity line.
export function LiveActivityFeed({ task, details }: { task: Task; details: TaskDetails | null }): React.JSX.Element | null {
  const working = isWorkingState(task.state);
  const activities = useMemo(
    () => (working && details !== null ? recentActivities(buildTimeline(task, details), 8) : []),
    [details, task, working],
  );
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const element = list.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [activities]);

  if (!working) return null;
  const running = activities.filter((entry) => entry.tone === 'running').length;
  const state = details?.steps.filter((step) => step.status === 'running').length ?? 0;

  return (
    <section aria-label="Live CLI activity" className="mx-auto w-full max-w-(--chat-max) pb-2">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/30">
        <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-2xs text-muted-foreground">
          <ActivityIcon size={13} className="shrink-0 text-info" />
          <span className="shrink-0 font-medium text-shimmer">Live CLI activity</span>
          <span className="min-w-0 truncate">
            {state > 0 ? `· ${state} agent${state === 1 ? '' : 's'} working` : running > 0 ? '· streaming' : '· preparing'}
          </span>
          <span className="ml-auto shrink-0 text-3xs tabular-nums">{activities.length > 0 ? `last ${activities.length} steps` : 'waiting for the agent'}</span>
        </div>
        {activities.length === 0 ? (
          <p className="border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">Waiting for the agent to start…</p>
        ) : (
          <ol
            ref={list}
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            className="max-h-28 overflow-y-auto border-t border-border/60 px-2 py-1"
          >
            {activities.map((entry, index) => {
              const latest = index === activities.length - 1;
              return (
                <li key={entry.id} className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-2xs">
                  <WorkIcon
                    icon={entry.icon}
                    size={11}
                    className={cn('shrink-0', entry.tone === 'error' ? 'text-destructive' : entry.tone === 'running' ? 'text-info' : 'text-muted-foreground')}
                  />
                  {entry.source !== undefined ? (
                    <span className="shrink-0 rounded border border-border/70 px-1 py-px text-3xs text-muted-foreground">{entry.source}</span>
                  ) : null}
                  <span
                    title={entry.detail ?? entry.label}
                    className={cn(
                      'min-w-0 flex-1 truncate text-left',
                      entry.icon === 'terminal' || entry.icon === 'file' ? 'font-mono' : '',
                      entry.tone === 'running' && latest ? 'text-shimmer' : entry.tone === 'error' ? 'text-destructive-foreground' : 'text-foreground/80',
                    )}
                  >
                    {entry.label}
                  </span>
                  {entry.tone === 'running' && latest ? <Spinner size={10} className="shrink-0 text-info" /> : null}
                  <time dateTime={entry.at} className="hidden shrink-0 text-3xs text-muted-foreground/60 tabular-nums sm:inline">
                    {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
