import type { Task, Workspace } from '@shared/domain';
import { useWorkspaceChanges } from '../../hooks/useWorkspaceChanges';
import { useUiStore } from '../../stores';
import { isWorkingState } from '../../lib/thread-status';
import { GitBranchIcon, MonitorIcon, PullRequestIcon } from '../ui/icons';

// The thread environment bar: the device this thread runs on (a monitor
// glyph for this Mac), the branch it writes to, and its change totals.
// Clicking Changes opens the diff viewer.
//
// Placement is width-aware. The floating card is positioned over the gutter
// beside the centered chat column (--chat-max, 48rem) — but that gutter only
// exists on wide windows: sidebar (268px) + chat column (768px) + the card
// (240px + offsets) needs roughly a 1600px viewport. Below that the floating
// card would sit on top of the messages (it is absolutely positioned), so
// instead a compact in-flow strip renders under the header, aligned with
// the chat column, and the floating card stays hidden.

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
    ? <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-px text-3xs font-medium text-primary">worktree</span>
    : null;

  return (
    <>
      <aside aria-label="Thread environment" className="bar-card absolute top-14 right-4 z-10 hidden w-64 flex-col min-[1600px]:flex">
        <p className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-[13px] text-foreground">
          <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MonitorIcon size={13} />
          </span>
          <span className="font-medium">This Mac</span>
          <span className="ml-auto rounded-sm bg-accent px-1.5 py-px text-3xs font-medium text-muted-foreground">local</span>
        </p>
        <p className="flex min-w-0 items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground" title={branch}>
          <GitBranchIcon size={12} className="shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground/75">{branch}</span>
          {worktreeBadge}
        </p>
        <button
          type="button"
          onClick={() => { openDetails('files'); }}
          className="mt-1 flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          title="Open changed files and diffs"
        >
          <PullRequestIcon size={13} className="text-primary" />
          Changes
          <span className="ml-auto">{totals}</span>
        </button>
      </aside>
      <div className="px-5 pt-3 min-[1600px]:hidden">
        <div className="bar-card mx-auto flex w-full max-w-(--chat-max) items-center gap-2.5 px-3 py-2 text-xs text-muted-foreground">
          <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MonitorIcon size={13} />
          </span>
          <span className="shrink-0 font-medium text-foreground">This Mac</span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5" title={branch}>
            <GitBranchIcon size={12} className="shrink-0 text-primary" />
            <span className="min-w-0 truncate font-mono text-2xs text-foreground/75">{branch}</span>
          </span>
          {worktreeBadge}
          <button
            type="button"
            onClick={() => { openDetails('files'); }}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2 py-1 font-medium text-foreground transition-colors hover:bg-border focus-visible:outline-2 focus-visible:outline-ring"
            title="Open changed files and diffs"
          >
            <PullRequestIcon size={12} className="text-primary" />
            Changes {totals}
          </button>
        </div>
      </div>
    </>
  );
}
