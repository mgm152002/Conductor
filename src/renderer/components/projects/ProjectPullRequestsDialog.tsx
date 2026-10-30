import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PullRequestRecord, PullRequestState } from '@shared/github-contract';
import type { Workspace } from '@shared/domain';
import { useTaskStore } from '../../stores';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Button, Dialog } from '../ui/primitives';
import { ExternalLinkIcon, PullRequestIcon } from '../ui/icons';

// Every pull request on a project's GitHub repository — synced from GitHub,
// not just the ones Conductor filed — with the Work thread each one belongs
// to (when its branch is a thread branch). Opened from the PR icon on the
// project's sidebar header. Clicking a linked row opens the thread; the
// button opens the PR on GitHub.

const STATE_CLASS: Record<PullRequestState, string> = {
  open: 'text-success',
  merged: 'text-violet-500',
  closed: 'text-destructive',
};

type Filter = 'all' | PullRequestState;

export function ProjectPullRequestsDialog({ project, open, onClose }: { project: Workspace; open: boolean; onClose: () => void }): React.JSX.Element {
  const tasks = useTaskStore((s) => s.tasks);
  const { openThread } = useThreadNavigation();
  const [prs, setPrs] = useState<PullRequestRecord[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    try {
      const status = await window.conductor.github.status(project.id);
      setConnected(status.connected);
      // When connected, sync the repo's full PR list; otherwise show what
      // Conductor recorded locally.
      setPrs(status.connected
        ? await window.conductor.github.refreshPrs(project.id)
        : await window.conductor.github.listPrs(project.id));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [project.id]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const refresh = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { setPrs(await window.conductor.github.refreshPrs(project.id)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const counts = useMemo(() => ({
    all: prs.length,
    open: prs.filter((pr) => pr.state === 'open').length,
    merged: prs.filter((pr) => pr.state === 'merged').length,
    closed: prs.filter((pr) => pr.state === 'closed').length,
  }), [prs]);
  const visible = filter === 'all' ? prs : prs.filter((pr) => pr.state === filter);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Pull requests · ${project.name}`}
      description={connected === false
        ? 'GitHub is not connected for this project. Connect it in Settings → GitHub to sync its pull requests.'
        : 'Every pull request on this project’s GitHub repository, with the thread each one belongs to.'}
      width="max-w-xl"
      footer={<>
        {connected === true ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void refresh(); }}>{busy ? 'Syncing…' : 'Sync from GitHub'}</Button> : null}
        <Button size="sm" variant="primary" onClick={onClose}>Done</Button>
      </>}
    >
      {prs.length > 0 ? (
        <div role="tablist" aria-label="Filter pull requests" className="mb-3 flex gap-1">
          {(['all', 'open', 'merged', 'closed'] as Filter[]).map((state) => (
            <button
              key={state}
              role="tab"
              aria-selected={filter === state}
              onClick={() => { setFilter(state); }}
              className={cn(
                'h-6 cursor-pointer rounded-full px-2.5 text-2xs font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                filter === state ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {state} · {counts[state]}
            </button>
          ))}
        </div>
      ) : null}
      {error !== null ? <p role="alert" className="mb-2 text-xs text-destructive-foreground">{error}</p> : null}
      {prs.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {connected === null ? 'Loading pull requests…' : 'No pull requests found on this repository.'}
        </p>
      ) : visible.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No {filter} pull requests.</p>
      ) : (
        <ul className="flex max-h-[50vh] flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border">
          {visible.map((pr) => {
            const root = pr.threadKey !== '' ? tasks[pr.threadKey] : undefined;
            return (
              <li key={pr.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <PullRequestIcon size={15} className={cn('shrink-0', STATE_CLASS[pr.state])} />
                <button
                  type="button"
                  disabled={root === undefined}
                  onClick={() => { if (root !== undefined) { onClose(); void openThread(root); } }}
                  title={root !== undefined ? `Open thread: ${pr.threadTitle}` : 'Not linked to a Conductor thread'}
                  className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-ring enabled:cursor-pointer"
                >
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    #{pr.number} {pr.title}
                    <span className={cn('ml-2 text-3xs font-medium capitalize', STATE_CLASS[pr.state])}>{pr.state}</span>
                  </span>
                  <span className="block truncate text-3xs text-muted-foreground">
                    {root !== undefined ? <>Thread: {pr.threadTitle} · </> : 'Not linked to a thread · '}
                    <span className="font-mono">{pr.branch}</span> · updated {relativeTime(pr.updatedAt)}
                  </span>
                </button>
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`Open pull request #${pr.number} on GitHub`}
                  onClick={() => { void window.conductor.github.openPr(pr.url).catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); }); }}
                >
                  <ExternalLinkIcon size={12} /> GitHub
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
