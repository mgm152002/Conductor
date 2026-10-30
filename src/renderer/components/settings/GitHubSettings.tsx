import { useCallback, useEffect, useState } from 'react';
import type { GitHubConnectionStatus, PullRequestRecord } from '@shared/github-contract';
import type { Workspace } from '@shared/domain';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../../stores';
import { prPath } from '../../lib/pull-request';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Button } from '../ui/primitives';
import { ExternalLinkIcon, PullRequestIcon } from '../ui/icons';

// Per-project GitHub connections: every project gets its own block. The
// repository is detected from that project's git `origin` remote; the user
// supplies a personal access token (stored in the macOS Keychain by the main
// process, never shown again). With "open a PR automatically" on, a finished
// Work thread's branch is pushed and a pull request filed for it.

function ProjectGitHub({ project }: { project: Workspace }): React.JSX.Element {
  const navigate = useNavigate();
  const [status, setStatus] = useState<GitHubConnectionStatus | null>(null);
  const [prs, setPrs] = useState<PullRequestRecord[]>([]);
  const [token, setToken] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.conductor.github.status(project.id);
      setStatus(next);
      setBaseBranch(next.baseBranch ?? '');
      setPrs(next.connected
        ? await window.conductor.github.refreshPrs(project.id)
        : await window.conductor.github.listPrs(project.id));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [project.id]);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (action: () => Promise<GitHubConnectionStatus>): Promise<void> => {
    setBusy(true); setError(null);
    try { setStatus(await action()); setToken(''); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><PullRequestIcon size={14} /> {project.name}</h3>
        <p className="mt-0.5 truncate text-3xs text-muted-foreground" title={project.rootPath}>{project.rootPath}</p>
      </div>
      {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
      {status === null ? <p className="text-xs text-muted-foreground">Checking connection…</p> : (
        <>
          <dl className="flex flex-col gap-1.5 text-xs">
            <div className="flex gap-2"><dt className="w-28 shrink-0 text-muted-foreground">Repository</dt><dd className="font-mono text-foreground">{status.repo !== null ? status.repo.fullName : 'No GitHub `origin` remote detected'}</dd></div>
            <div className="flex gap-2"><dt className="w-28 shrink-0 text-muted-foreground">Connection</dt><dd className="text-foreground">{status.connected ? `Connected${status.login !== undefined ? ` as ${status.login}` : ''}` : 'Not connected'}</dd></div>
          </dl>
          {status.lastError !== undefined ? (
            <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2 text-xs text-destructive-foreground">
              The last automatic PR failed: {status.lastError}
            </p>
          ) : null}
          {!status.connected ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => { event.preventDefault(); void run(() => window.conductor.github.connect({ workspaceId: project.id, token: token.trim() })); }}
            >
              <label className="sr-only" htmlFor={`github-token-${project.id}`}>GitHub personal access token for {project.name}</label>
              <input
                id={`github-token-${project.id}`}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => { setToken(event.target.value); }}
                placeholder="GitHub personal access token (repo scope)"
                className="h-8 min-w-64 flex-1 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
              <Button size="sm" variant="primary" type="submit" disabled={busy || token.trim() === ''}>{busy ? 'Connecting…' : 'Connect GitHub'}</Button>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={status.autoPr}
                  disabled={busy}
                  onChange={(event) => { void run(() => window.conductor.github.setAutoPr({ workspaceId: project.id, enabled: event.target.checked })); }}
                  className="size-3.5 accent-primary"
                />
                Open a pull request automatically when an agent finishes a thread
              </label>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => { event.preventDefault(); void run(() => window.conductor.github.setBaseBranch({ workspaceId: project.id, branch: baseBranch.trim() })); }}
              >
                <label className="text-xs text-muted-foreground" htmlFor={`github-base-${project.id}`}>Base branch</label>
                <input
                  id={`github-base-${project.id}`}
                  value={baseBranch}
                  onChange={(event) => { setBaseBranch(event.target.value); }}
                  placeholder="Repository default (e.g. main)"
                  className="h-8 w-48 rounded-lg border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                />
                <Button size="sm" variant="outline" type="submit" disabled={busy}>Save</Button>
                <span className="flex-1" />
                <Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => { void run(() => window.conductor.github.disconnect(project.id)); }}>Disconnect</Button>
              </form>
              <div>
                <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
                  Pull requests · {prs.length}
                  <span className="flex-1" />
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => { void refresh(); }}>Sync from GitHub</Button>
                </h4>
                {prs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No pull requests found on this repository.</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
                    {prs.map((pr) => (
                      <li key={pr.id} className="flex items-center gap-2.5 px-3 py-2 text-xs">
                        <PullRequestIcon size={13} className={cn('shrink-0', pr.state === 'merged' ? 'text-violet-500' : pr.state === 'closed' ? 'text-destructive' : 'text-success')} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">#{pr.number} {pr.title}</span>
                          <span className="block truncate text-3xs text-muted-foreground">
                            {pr.threadKey !== '' ? `Thread: ${pr.threadTitle} · ` : 'Not linked to a thread · '}
                            <span className="font-mono">{pr.branch}</span> · {pr.state} · updated {relativeTime(pr.updatedAt)}
                          </span>
                        </span>
                        <Button size="xs" variant="primary" aria-label={`Read pull request #${pr.number} in Conductor`} onClick={() => { navigate(prPath(project.id, pr.number)); }}>
                          Read PR
                        </Button>
                        <Button size="xs" variant="outline" aria-label={`Open pull request #${pr.number} on GitHub`} onClick={() => { void window.conductor.github.openPr(pr.url).catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); }); }}>
                          <ExternalLinkIcon size={11} /> GitHub
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function GitHubSettings(): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  if (workspaces.length === 0) {
    return <p className="text-xs text-muted-foreground">Add a project first, then connect it to GitHub here.</p>;
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="-mb-4 text-xs text-muted-foreground">
        Connect each project to its GitHub repository. When an agent finishes a Work thread, Conductor commits the
        thread worktree, pushes its branch, and opens a pull request linked to the thread.
      </p>
      {workspaces.map((project, index) => (
        <div key={project.id} className={index > 0 ? 'border-t border-border pt-6' : undefined}>
          <ProjectGitHub project={project} />
        </div>
      ))}
    </div>
  );
}
