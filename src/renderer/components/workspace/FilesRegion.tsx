import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@shared/domain';
import type { ChangedFile, ChangedFileDiff, ChangedFileStatus, TaskDetails } from '@shared/task-view';
import { useWorkspaceChanges } from '../../hooks/useWorkspaceChanges';
import { isWorkingState } from '../../lib/thread-status';
import { diffLineKind } from '../../lib/diff';
import { cn } from '../../lib/cn';
import { Button } from '../ui/primitives';
import { ChevronRightIcon, RotateIcon, Spinner } from '../ui/icons';
import { ArtifactsRegion } from './ArtifactsRegion';
import { RegionCard } from './RegionCard';

// The Files tab: uncommitted Git changes with per-file unified diffs, followed
// by the outputs the task actually recorded. Everything is read-only; the main
// process resolves paths inside the workspace and bounds/redacts diff text.

const STATUS: Record<ChangedFileStatus, { label: string; letter: string; textClass: string }> = {
  added: { label: 'Added', letter: 'A', textClass: 'text-success' },
  modified: { label: 'Modified', letter: 'M', textClass: 'text-warning' },
  deleted: { label: 'Deleted', letter: 'D', textClass: 'text-destructive-foreground' },
  renamed: { label: 'Renamed', letter: 'R', textClass: 'text-info' },
  untracked: { label: 'New file', letter: 'U', textClass: 'text-info' },
  conflicted: { label: 'Conflict', letter: 'C', textClass: 'text-destructive-foreground' },
};

function statusTextClass(status: { textClass: string }): string {
  return status.textClass;
}

const MAX_DIFF_LINES = 2_000;

/** Split a repository-relative path into a readable filename and directory. */
function splitFilePath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { name: path, directory: '' }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}

function DiffView({ diff }: { diff: ChangedFileDiff }): React.JSX.Element {
  const lines = useMemo(() => diff.patch.split('\n'), [diff.patch]);
  if (diff.patch.trim() === '') {
    return <p className="border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground">No textual changes (binary file or mode-only change).</p>;
  }
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return (
    <div className="border-t border-border/60">
      <div className="max-h-80 overflow-auto font-mono text-2xs leading-relaxed">
        {shown.map((line, index) => {
          const kind = diffLineKind(line);
          return (
            <div
              key={`${index}:${line.slice(0, 24)}`}
              className={cn(
                'min-w-0 px-2.5 whitespace-pre-wrap break-words',
                kind === 'add' ? 'bg-success/10 text-success' : '',
                kind === 'delete' ? 'bg-destructive/10 text-destructive-foreground' : '',
                kind === 'hunk' ? 'bg-info/10 text-info' : '',
                kind === 'header' ? 'text-muted-foreground/80' : '',
                kind === 'context' ? 'text-muted-foreground' : '',
              )}
            >
              {line === '' ? ' ' : line}
            </div>
          );
        })}
      </div>
      {diff.truncated || lines.length > shown.length ? (
        <p className="px-2.5 py-1 text-3xs text-muted-foreground">
          {diff.truncated ? 'Diff truncated by Conductor.' : `Showing the first ${MAX_DIFF_LINES.toLocaleString()} lines.`}
        </p>
      ) : null}
    </div>
  );
}

function ChangedFileRow({ workspaceId, taskId, file, revision }: { workspaceId: string; taskId?: string; file: ChangedFile; revision: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<ChangedFileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const status = STATUS[file.status];
  const { name, directory } = splitFilePath(file.path);

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const next = await window.conductor.workspace.fileDiff({ workspaceId, path: file.path, ...(taskId ? { taskId } : {}) });
      if (sequence === request.current) setDiff(next);
    } catch (err) {
      if (sequence === request.current) setError(err instanceof Error ? err.message : 'Could not read the file diff');
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }, [workspaceId, taskId, file.path]);

  // Load on expand and keep an open diff current as the working tree changes.
  useEffect(() => {
    if (!expanded) return;
    void load();
    return () => { request.current += 1; };
  }, [expanded, load, revision]);

  return (
    <li>
      <button
        type="button"
        onClick={() => { setExpanded((value) => !value); }}
        aria-expanded={expanded}
        title={file.previousPath !== undefined ? `${file.previousPath} → ${file.path}` : file.path}
        className={cn('flex w-full cursor-pointer items-center gap-2 px-3 py-[7px] text-left transition-colors hover:bg-accent/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring', expanded && 'bg-accent/50')}
      >
        <ChevronRightIcon size={11} className={cn('shrink-0 text-muted-foreground/70 transition-transform', expanded && 'rotate-90')} />
        <span className={cn('w-3 shrink-0 text-center font-mono text-2xs font-semibold', statusTextClass(status))} title={status.label}>{status.letter}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight text-foreground" title={file.path}>{name}</span>
          {directory !== '' || file.previousPath !== undefined ? (
            <span className="block truncate font-mono text-3xs leading-tight text-muted-foreground/80" title={file.path}>
              {file.previousPath !== undefined ? `from ${file.previousPath}` : directory}
            </span>
          ) : null}
        </span>
        {file.additions !== undefined || file.deletions !== undefined ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums">
            <span className="text-success">+{file.additions ?? 0}</span>
            <span className="text-destructive-foreground">−{file.deletions ?? 0}</span>
          </span>
        ) : (
          <span className="shrink-0 text-3xs text-muted-foreground">{status.label}</span>
        )}
      </button>
      {expanded ? (
        loading && diff === null ? (
          <p role="status" className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground"><Spinner size={10} />Reading diff…</p>
        ) : error !== null ? (
          <p role="alert" className="border-t border-border/60 px-3 py-2 text-2xs text-destructive-foreground">{error}</p>
        ) : diff !== null ? <DiffView diff={diff} /> : null
      ) : null}
    </li>
  );
}

export function FilesRegion({ task, details }: { task: Task | null; details: TaskDetails | null }): React.JSX.Element {
  const state = details?.task.state ?? task?.state;
  const workspaceId = task?.workspaceId ?? details?.task.workspaceId ?? null;
  const refreshKey = details?.task.updatedAt ?? task?.updatedAt ?? '';
  const taskId = task?.id ?? details?.task.id ?? null;
  const { changes, loading, error, refresh } = useWorkspaceChanges(workspaceId, refreshKey, state !== undefined && isWorkingState(state), taskId);
  const [nonce, setNonce] = useState(0);
  const files = changes?.files ?? [];
  const isRepository = changes?.isRepository !== false;
  const emptyLabel = isRepository
    ? changes?.baseBranch !== undefined
      ? `No changes on this branch compared with ${changes.baseBranch}.`
      : 'No uncommitted changes in this project.'
    : 'This project is not a Git repository, so changed files can’t be listed.';

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {changes?.worktree === true && changes.branch !== undefined ? (
        <p className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground" title={`${changes.branch} — changes stay here until you merge this branch`}>
          <span className="shrink-0 rounded-full bg-primary/12 px-2 py-0.5 font-medium text-primary">Worktree</span>
          <span className="min-w-0 flex-1 truncate font-mono">{changes.branch}</span>
        </p>
      ) : null}
      <RegionCard
        bare
        title="Changed files"
        count={files.length}
        {...(changes !== null ? { subtitle: isRepository ? `${files.reduce((sum, f) => sum + (f.additions ?? 0), 0) > 0 || files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) > 0 ? `+${files.reduce((sum, f) => sum + (f.additions ?? 0), 0)} −${files.reduce((sum, f) => sum + (f.deletions ?? 0), 0)}` : `${files.length} changed`}${changes.baseBranch !== undefined ? ` vs ${changes.baseBranch}` : ''}` : 'Not a Git repository' } : {})}
        action={(
          <Button size="icon-sm" variant="ghost" aria-label="Refresh changed files" title="Refresh changed files" onClick={() => { refresh(); setNonce((value) => value + 1); }}>
            <RotateIcon size={12} />
          </Button>
        )}
        emptyLabel={emptyLabel}
        isEmpty={changes !== null && error === null && files.length === 0}
      >
        {loading && changes === null ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner size={11} />Reading the project working tree…</p>
        ) : error !== null ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-2xs text-destructive-foreground">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <Button size="xs" variant="ghost" onClick={refresh}>Retry</Button>
          </div>
        ) : files.length > 0 ? (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card">
            {files.map((file) => (
              <ChangedFileRow
                key={file.path}
                workspaceId={workspaceId ?? ''}
                {...(taskId !== null ? { taskId } : {})}
                file={file}
                revision={`${refreshKey}:${nonce}:${file.status}:${file.additions ?? ''}:${file.deletions ?? ''}`}
              />
            ))}
          </ul>
        ) : null}
      </RegionCard>
      <ArtifactsRegion task={task} details={details} />
    </div>
  );
}
