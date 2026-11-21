import { useCallback, useEffect, useState } from 'react';
import type { GitHubConnectionStatus, PullRequestRecord } from '@shared/github-contract';
import type { Workspace } from '@shared/domain';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../../stores';
import { prPath } from '../../lib/pull-request';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Badge, Button, Switch, inputClassName } from '../ui/primitives';
import { ExternalLinkIcon, PullRequestIcon, RotateIcon } from '../ui/icons';
import { EntityIcon } from '../ui/EntityIcon';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

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

  const statusBadge = status === null ? null
    : status.connected ? <Badge tone="success">Connected{status.login !== undefined ? ` as ${status.login}` : ''}</Badge>
      : <Badge>Not connected</Badge>;

  // Settings shape: a titled section per project, its options as grouped rows.
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title={<><EntityIcon icon={project.icon ?? null} name={project.name} kind="project" size={18} /><span className="truncate">{project.name}</span></>}
        action={statusBadge ?? undefined}
      >
        <SettingsGroup>
          <SettingsRow title="Repository"
            description={<span className="font-mono" title={project.rootPath}>{status === null ? 'Checking connection…' : status.repo !== null ? status.repo.fullName : 'No GitHub origin remote detected'}</span>}
            {...(status?.connected === true ? { control: <Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => { void run(() => window.conductor.github.disconnect(project.id)); }}>Disconnect</Button> } : {})} />
          {status !== null && !status.connected ? (
            <SettingsRow title="Personal access token" description="Needs the repo scope. Stored in the macOS Keychain and never shown again."
              control={(
                <form className="flex w-full items-center gap-2 sm:w-auto" onSubmit={(event) => { event.preventDefault(); void run(() => window.conductor.github.connect({ workspaceId: project.id, token: token.trim() })); }}>
                  <label className="sr-only" htmlFor={`github-token-${project.id}`}>GitHub personal access token for {project.name}</label>
                  <input id={`github-token-${project.id}`} type="password" autoComplete="off" value={token} onChange={(event) => { setToken(event.target.value); }} placeholder="ghp_…" className={cn(inputClassName, 'w-full font-mono sm:w-56')} />
                  <Button size="sm" variant="primary" type="submit" disabled={busy || token.trim() === ''}>{busy ? 'Connecting…' : 'Connect'}</Button>
                </form>
              )} />
          ) : null}
          {status?.connected === true ? (
            <>
              <SettingsRow title="Open pull requests automatically" description="When an agent finishes a change, push its branch and open a PR. Questions and explanations never open one."
                control={<Switch label="Open a pull request automatically" checked={status.autoPr} disabled={busy} onChange={(enabled) => { void run(() => window.conductor.github.setAutoPr({ workspaceId: project.id, enabled })); }} />} />
              <SettingsRow title="Base branch" description="Pull requests target this branch. Leave empty for the repository default."
                control={(
                  <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void run(() => window.conductor.github.setBaseBranch({ workspaceId: project.id, branch: baseBranch.trim() })); }}>
                    <label className="sr-only" htmlFor={`github-base-${project.id}`}>Base branch</label>
                    <input id={`github-base-${project.id}`} value={baseBranch} onChange={(event) => { setBaseBranch(event.target.value); }} placeholder="main" className={cn(inputClassName, 'w-40 font-mono')} />
                    <Button size="sm" variant="outline" type="submit" disabled={busy}>Save</Button>
                  </form>
                )} />
            </>
          ) : null}
        </SettingsGroup>
        {error !== null ? <p role="alert" className="px-3 text-xs text-destructive-foreground sm:px-4">{error}</p> : null}
        {status?.lastError !== undefined ? <p role="alert" className="px-3 text-xs text-destructive-foreground sm:px-4">The last automatic PR failed: {status.lastError}</p> : null}
      </SettingsSection>

      {status?.connected === true ? (
        <SettingsSection title={<span className="text-sm font-medium text-muted-foreground">Pull requests · {prs.length}</span>}
          action={<Button size="xs" variant="ghost" disabled={busy} onClick={() => { void refresh(); }}><RotateIcon size={12} />Sync from GitHub</Button>}>
          <SettingsGroup>
            {prs.length === 0 ? <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">No pull requests found on this repository.</p> : prs.map((pr) => (
              <div key={pr.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                <PullRequestIcon size={14} className={cn('shrink-0', pr.state === 'merged' ? 'text-violet-500' : pr.state === 'closed' ? 'text-destructive' : 'text-success')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground"><span className="text-muted-foreground">#{pr.number}</span> {pr.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {pr.threadKey !== '' ? `${pr.threadTitle} · ` : 'Not linked to a thread · '}
                    <span className="font-mono">{pr.branch}</span> · {pr.state} · {relativeTime(pr.updatedAt)}
                  </span>
                </span>
                <Button size="sm" variant="ghost" aria-label={`Read pull request #${pr.number} in Conductor`} onClick={() => { navigate(prPath(project.id, pr.number)); }}>Read</Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Open pull request #${pr.number} on GitHub`} title="Open on GitHub" onClick={() => { void window.conductor.github.openPr(pr.url).catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); }); }}>
                  <ExternalLinkIcon size={13} />
                </Button>
              </div>
            ))}
          </SettingsGroup>
        </SettingsSection>
      ) : null}
    </div>
  );
}

export function GitHubSettings(): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  if (workspaces.length === 0) {
    return <p className="px-3 text-xs text-muted-foreground sm:px-4">Add a project first, then connect it to GitHub here.</p>;
  }

  return (
    <div className="flex flex-col gap-10">
      <p className="-mb-4 px-3 text-sm text-muted-foreground sm:px-4">
        Connect each project to its GitHub repository. When an agent finishes a Work thread, Conductor commits the
        thread worktree, pushes its branch, and opens a pull request linked to the thread.
      </p>
      {workspaces.map((project) => <ProjectGitHub key={project.id} project={project} />)}
    </div>
  );
}
