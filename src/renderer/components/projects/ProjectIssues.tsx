import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IssueList, IssueRecord } from '@shared/github-contract';
import type { Workspace } from '@shared/domain';
import { useTaskStore, useUiStore } from '../../stores';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import { threadTitle } from '../../lib/thread-status';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Button } from '../ui/primitives';
import { ExternalLinkIcon, IssueClosedIcon, IssueIcon, MessageIcon, PlusIcon, SearchIcon, Spinner } from '../ui/icons';

// The Issues tab of a project's GitHub panel: the repository's issues, each
// with the Work threads started from it. "Start thread" opens a new thread
// in this project with the issue (description and comments) attached and a
// first message ready to edit; once sent, the thread is linked to the issue.

type Filter = 'open' | 'closed';

/** Readable text on a GitHub label colour (hex without #). */
function labelStyle(color: string): React.CSSProperties | undefined {
  if (!/^[0-9a-f]{6}$/i.test(color)) return undefined;
  return { backgroundColor: `#${color}26`, borderColor: `#${color}66` };
}

export function ProjectIssues({ project, onClose }: { project: Workspace; onClose: () => void }): React.JSX.Element {
  const tasks = useTaskStore((s) => s.tasks);
  const { newThread, openThread } = useThreadNavigation();
  const [filter, setFilter] = useState<Filter>('open');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<IssueList | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (state: Filter) => {
    setLoading(true); setError(null);
    try { setList(await window.conductor.github.listIssues({ workspaceId: project.id, state })); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, [project.id]);
  useEffect(() => { void load(filter); }, [load, filter]);

  const visible = useMemo(() => {
    const issues = list?.issues ?? [];
    const q = query.trim().toLowerCase().replace(/^#/, '');
    if (q === '') return issues;
    return issues.filter((issue) => String(issue.number).startsWith(q) || issue.title.toLowerCase().includes(q)
      || issue.labels.some((label) => label.name.toLowerCase().includes(q)) || issue.author.toLowerCase().includes(q));
  }, [list, query]);

  async function start(issue: IssueRecord): Promise<void> {
    setStarting(issue.number); setError(null);
    try {
      const context = await window.conductor.github.issueContext({ workspaceId: project.id, number: issue.number });
      useUiStore.getState().setComposerSeed({
        workspaceId: project.id,
        text: `Work on issue #${issue.number}: ${issue.title}`,
        attachment: { name: `issue-${issue.number}.md`, markdown: context.markdown },
        issue: { number: issue.number },
      });
      onClose();
      await newThread(project.id);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setStarting(null); }
  }

  const openLinked = (threadKey: string): void => {
    onClose();
    void openThread({ id: threadKey, workspaceId: project.id });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Filter issues" className="flex gap-1">
          {(['open', 'closed'] as Filter[]).map((state) => (
            <button
              key={state}
              type="button"
              role="tab"
              aria-selected={filter === state}
              onClick={() => { setFilter(state); }}
              className={cn(
                'h-6 cursor-pointer rounded-full px-2.5 text-2xs font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                filter === state ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {state}
            </button>
          ))}
        </div>
        <label className="ms-auto flex h-7 min-w-0 flex-1 basis-40 items-center gap-1.5 rounded-lg border border-input px-2 text-xs focus-within:border-ring/60 sm:max-w-56">
          <SearchIcon size={12} className="shrink-0 text-muted-foreground" />
          <span className="sr-only">Search issues</span>
          <input value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder="Search by title, #, label" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60" />
        </label>
      </div>
      {list !== null && list.repo !== null && !list.connected ? (
        <p className="text-3xs text-muted-foreground">Reading {list.repo.fullName} without a token. Connect GitHub in Settings → GitHub for private repositories and higher rate limits.</p>
      ) : null}
      {error !== null ? <p role="alert" className="text-xs text-destructive-foreground [overflow-wrap:anywhere]">{error}</p> : null}
      {list === null && loading ? (
        <p role="status" className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"><Spinner size={12} />Loading issues…</p>
      ) : list !== null && list.repo === null ? (
        <p className="py-6 text-center text-xs text-muted-foreground">This project has no GitHub <code className="font-mono">origin</code> remote, so it has no issues to show.</p>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{query.trim() !== '' ? 'No issues match your search.' : `No ${filter} issues.`}</p>
      ) : (
        <ul className={cn('flex max-h-[50vh] flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border', loading && 'opacity-60')} aria-busy={loading}>
          {visible.map((issue) => {
            const linked = issue.threadKeys[0];
            const linkedRoot = linked !== undefined ? tasks[linked] : undefined;
            return (
              <li key={issue.number} className="flex items-start gap-3 px-3.5 py-2.5">
                {issue.state === 'open'
                  ? <IssueIcon size={15} className="mt-0.5 shrink-0 text-success" />
                  : <IssueClosedIcon size={15} className="mt-0.5 shrink-0 text-violet-500" />}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium break-words text-foreground">
                    <span className="text-muted-foreground">#{issue.number}</span> {issue.title}
                  </p>
                  {issue.labels.length > 0 ? (
                    <ul className="mt-1 flex flex-wrap gap-1" aria-label="Labels">
                      {issue.labels.slice(0, 6).map((label) => (
                        <li key={label.name} style={labelStyle(label.color)} className="rounded-full border border-border px-1.5 py-px text-3xs text-foreground/85">{label.name}</li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-3xs text-muted-foreground">
                    <span>@{issue.author}</span>
                    <span>· updated {relativeTime(issue.updatedAt)}</span>
                    {issue.comments > 0 ? <span className="inline-flex items-center gap-0.5">· <MessageIcon size={10} />{issue.comments}</span> : null}
                    {linked !== undefined ? (
                      <button type="button" onClick={() => { openLinked(linked); }} className="cursor-pointer text-primary hover:underline">
                        · Thread: {linkedRoot !== undefined ? threadTitle(linkedRoot) : 'open'}{issue.threadKeys.length > 1 ? ` (+${issue.threadKeys.length - 1})` : ''}
                      </button>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="xs" variant={linked !== undefined ? 'outline' : 'primary'} disabled={starting !== null} onClick={() => { void start(issue); }}
                    aria-label={`Start a thread for issue #${issue.number}`} title="Start a new thread with this issue attached">
                    {starting === issue.number ? <Spinner size={11} /> : <PlusIcon size={12} />}Thread
                  </Button>
                  <Button size="xs" variant="ghost" aria-label={`Open issue #${issue.number} on GitHub`} title="Open on GitHub"
                    onClick={() => { void window.conductor.github.openIssue({ workspaceId: project.id, number: issue.number }).catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); }); }}>
                    <ExternalLinkIcon size={12} />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex justify-end">
        <Button size="xs" variant="ghost" disabled={loading} onClick={() => { void load(filter); }}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
      </div>
    </div>
  );
}
