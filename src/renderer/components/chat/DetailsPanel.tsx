import { useEffect } from 'react';
import type { Task } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { useUiStore } from '../../stores/ui-store';
import { cn } from '../../lib/cn';
import { Button } from '../ui/primitives';
import { PullRequestIcon, XIcon } from '../ui/icons';
import { FilesRegion } from '../workspace/FilesRegion';

/**
 * The thread's diff viewer, floating over the conversation: changed files
 * and their diffs, nothing else. Plans, checks, context and logs live in
 * the conversation itself; artifacts are handed back there as documents.
 * Opens from the header toggle or the environment bar, and closes with
 * Escape, the close button, or the header toggle.
 */
export function DetailsPanel({ task, details, embedded = false }: { task: Task; details: TaskDetails | null; embedded?: boolean }): React.JSX.Element {
  const setOpen = useUiStore((s) => s.setDetailsOpen);
  useEffect(() => {
    if (embedded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [embedded, setOpen]);
  return (
    <aside
      aria-label="Changed files and diffs"
      className={cn(
        'flex min-h-0 min-w-0 flex-col',
        embedded
          ? 'h-full w-full bg-background'
          : 'animate-slide-in absolute top-14 right-4 bottom-4 z-20 w-[380px] max-w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-border-strong bg-surface-raised shadow-2xl',
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <PullRequestIcon size={12} />
        </span>
        <h2 className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-foreground">Changes</h2>
        {!embedded ? <Button size="icon-sm" variant="ghost" aria-label="Close changes" onClick={() => { setOpen(false); }}><XIcon size={13} /></Button> : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 [overflow-wrap:anywhere]">
        <FilesRegion task={task} details={details} />
      </div>
    </aside>
  );
}
