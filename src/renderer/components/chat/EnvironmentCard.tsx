import type { Task, Workspace } from '@shared/domain';
import { useWorkspaceChanges } from '../../hooks/useWorkspaceChanges';
import { useUiStore } from '../../stores';
import { isWorkingState } from '../../lib/thread-status';
import { ChevronRightIcon, GitBranchIcon, MonitorIcon } from '../ui/icons';

// The thread environment strip: where this thread runs (this Mac), the
// branch it writes to, and its change totals. Clicking Changes opens the
// diff viewer. It is one slim in-flow line under the header, aligned with
// the chat column at every window width, so it never covers a message.

export function EnvironmentCard({ task, project }: { task: Task; project: Workspace | undefined }): React.JSX.Element | null {
  const openDetails = useUiStore((s) => s.openDetails);
  const { changes } = useWorkspaceChanges(project?.id ?? null, task.updatedAt, isWorkingState(task.state), task.id);
  if (project === undefined) return null;
  const additions = changes?.files.reduce((sum, f) => sum + (f.additions ?? 0), 0) ?? 0;
  const deletions = changes?.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0;
  const branch = changes?.branch ?? `conductor/${(task.threadId ?? task.id).slice(0, 8)}`;
  const totals = (
    <span className="font-mono text-2xs tabular-nums">
      <span className="text-success">+{additions.toLocaleString()}</span>{' '}
      <span className="text-destructive-foreground">−{deletions.toLocaleString()}</span>
    </span>
  );
  const worktreeBadge = changes?.worktree === true
    ? <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-3xs font-medium text-muted-foreground">worktree</span>
    : null;

  return (
    <aside aria-label="Thread environment" className="shrink-0 px-5">
      <div className="mx-auto flex h-9 w-full max-w-(--chat-max) items-center gap-2.5 border-b border-border px-1 text-xs text-muted-foreground">
        <span className="flex shrink-0 items-center gap-1.5" title="This thread runs on this Mac">
          <MonitorIcon size={13} />
          This Mac
        </span>
        <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border-strong" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5" title={branch}>
          <GitBranchIcon size={12} className="shrink-0" />
          <span className="min-w-0 truncate font-mono text-2xs text-foreground/80">{branch}</span>
          {worktreeBadge}
        </span>
        <button
          type="button"
          onClick={() => { openDetails('files'); }}
          className="-mr-1 flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          title="Open changed files and diffs"
        >
          Changes {totals}
          <ChevronRightIcon size={11} className="text-muted-foreground" />
        </button>
      </div>
    </aside>
  );
}
