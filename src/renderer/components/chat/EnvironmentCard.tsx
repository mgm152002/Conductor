import type { Task, Workspace } from '@shared/domain';
import { useWorkspaceChanges } from '../../hooks/useWorkspaceChanges';
import { useUiStore } from '../../stores';
import { isWorkingState } from '../../lib/thread-status';

// The floating environment card from the T3 thread view: where this thread
// runs (this Mac, in its own worktree), the branch it writes to, and its
// change totals. Clicking Changes opens the details panel's Changes tab.

export function EnvironmentCard({ task, project }: { task: Task; project: Workspace | undefined }): React.JSX.Element | null {
  const openDetails = useUiStore((s) => s.openDetails);
  const { changes } = useWorkspaceChanges(project?.id ?? null, task.updatedAt, isWorkingState(task.state), task.id);
  if (project === undefined) return null;
  const additions = changes?.files.reduce((sum, f) => sum + (f.additions ?? 0), 0) ?? 0;
  const deletions = changes?.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0;
  const branch = changes?.branch ?? `conductor/${(task.threadId ?? task.id).slice(0, 8)}`;

  return (
    <aside aria-label="Thread environment" className="group-card absolute top-14 right-4 z-10 hidden w-60 flex-col shadow-xl lg:flex">
      <p className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-[13px] text-foreground">
        <span aria-hidden="true" className="text-muted-foreground">▣</span>
        This Mac
        <span className="ml-auto text-3xs text-muted-foreground">local</span>
      </p>
      <p className="flex min-w-0 items-center gap-2 px-3 py-1 text-xs text-muted-foreground" title={branch}>
        <span aria-hidden="true">⎇</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">{branch}</span>
        {changes?.worktree === true ? <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-px text-3xs font-medium text-primary">worktree</span> : null}
      </p>
      <button
        type="button"
        onClick={() => { openDetails('files'); }}
        className="mt-1 flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        title="Open changed files and diffs"
      >
        <span aria-hidden="true" className="text-muted-foreground">▤</span>
        Changes
        <span className="ml-auto font-mono text-2xs tabular-nums">
          <span className="text-success">+{additions.toLocaleString()}</span>{' '}
          <span className="text-destructive-foreground">−{deletions.toLocaleString()}</span>
        </span>
      </button>
    </aside>
  );
}
