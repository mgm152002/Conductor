import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PrMergeMethod, PullRequestBundle } from '@shared/github-contract';
import { usePrStore, useTaskStore } from '../stores';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { prPath } from '../lib/pull-request';
import { diffLineKind } from '../lib/diff';
import { relativeTime } from '../lib/time';
import { cn } from '../lib/cn';
import { Badge, Button, Dialog, textareaClassName } from '../components/ui/primitives';
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon, PullRequestIcon, RotateIcon, XIcon } from '../components/ui/icons';
import { Markdown } from '../components/chat/Markdown';

// The in-app pull-request reader: a simple tabbed view (Overview, Conversation,
// Commits, Files changed, Checks) covering the GitHub PR page's core jobs —
// read the description and diff, follow the discussion, check CI, review, and
// merge — without leaving Conductor.

type TabId = 'overview' | 'conversation' | 'commits' | 'files' | 'checks';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'commits', label: 'Commits' },
  { id: 'files', label: 'Files changed' },
  { id: 'checks', label: 'Checks' },
];

const STATE_TONE = { open: 'success', merged: 'primary', closed: 'destructive' } as const;

function PatchView({ patch }: { patch: string }): React.JSX.Element {
  return (
    <div className="max-h-96 overflow-auto border-t border-border/60 font-mono text-2xs leading-relaxed">
      {patch.split('\n').map((line, index) => {
        const kind = diffLineKind(line);
        return (
          <div key={index} className={cn('px-2.5 whitespace-pre-wrap break-words',
            kind === 'add' && 'bg-success/10 text-success', kind === 'delete' && 'bg-destructive/10 text-destructive-foreground',
            kind === 'hunk' && 'bg-info/10 text-info', kind === 'header' && 'text-muted-foreground/80', kind === 'context' && 'text-muted-foreground')}>
            {line === '' ? ' ' : line}
          </div>
        );
      })}
    </div>
  );
}

export function PullRequestScreen(): React.JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const workspaceId = params['workspaceId'] ?? '';
  const number = Number(params['number']);
  const tabs = usePrStore((s) => s.tabs);
  const tasks = useTaskStore((s) => s.tasks);
  const { openThread } = useThreadNavigation();
  const [bundle, setBundle] = useState<PullRequestBundle | null>(null);
  const [tab, setTab] = useState<TabId>('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [method, setMethod] = useState<PrMergeMethod>('merge');
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setLoading(true);
    try {
      const next = await window.conductor.github.getPr({ workspaceId, number });
      setBundle(next);
      setError(null);
      usePrStore.getState().setTitle(workspaceId, number, next.detail.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this pull request. Connect GitHub for this project in Settings → GitHub.');
    } finally { if (!quiet) setLoading(false); }
  }, [workspaceId, number]);

  useEffect(() => {
    usePrStore.getState().openTab({ workspaceId, number });
    setBundle(null); setTab('overview'); setNotice(null);
    void load();
  }, [workspaceId, number, load]);

  const run = async (label: string, action: () => Promise<PullRequestBundle>, success: string): Promise<void> => {
    setBusy(label); setError(null);
    try { setBundle(await action()); setNotice(success); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const detail = bundle?.detail;
  const linkedTask = detail !== undefined && detail.threadKey !== '' ? tasks[detail.threadKey] : undefined;
  const checksFailed = bundle?.checks.some((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out') ?? false;
  const checksPending = bundle?.checks.some((c) => c.status !== 'completed') ?? false;
  const canMerge = detail?.state === 'open' && !detail.draft && detail.mergeable !== false;

  return (
    // h-full (not flex-1): the routed wrapper in AppLayout is a plain block,
    // so flex-1 here got no definite height and the scroll area below grew
    // past the window and was clipped instead of scrolling.
    <div className="flex h-full min-h-0 flex-col">
      {/* Open PR tabs */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 pt-2" role="tablist" aria-label="Open pull requests">
        {tabs.map((t) => {
          const active = t.workspaceId === workspaceId && t.number === number;
          return (
            <span key={`${t.workspaceId}:${t.number}`} className={cn('flex shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 py-1.5 text-xs', active ? 'border-border bg-background font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              <button type="button" role="tab" aria-selected={active} className="max-w-44 cursor-pointer truncate" onClick={() => { navigate(prPath(t.workspaceId, t.number)); }}>
                #{t.number}{t.title !== undefined ? ` ${t.title}` : ''}
              </button>
              <button type="button" aria-label={`Close pull request #${t.number} tab`} className="cursor-pointer rounded p-0.5 hover:bg-accent" onClick={() => {
                const remaining = usePrStore.getState().closeTab(t.workspaceId, t.number);
                if (active) navigate(remaining.length > 0 ? prPath(remaining[remaining.length - 1]!.workspaceId, remaining[remaining.length - 1]!.number) : '/work');
              }}><XIcon size={11} /></button>
            </span>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-5">
          {loading && bundle === null ? <p role="status" className="text-sm text-muted-foreground">Loading pull request…</p> : null}
          {error !== null ? <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/6 px-3 py-2 text-xs text-destructive-foreground">{error}</p> : null}
          {notice !== null ? <p role="status" className="rounded-xl border border-success/25 bg-success/8 px-3 py-2 text-xs text-success">{notice}</p> : null}

          {detail !== undefined && bundle !== null ? <>
            <header className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="cursor-pointer text-xs text-muted-foreground hover:text-foreground" onClick={() => { navigate(-1); }}>← Back</button>
                <span className="text-xs text-muted-foreground">{detail.repoFullName}</span>
                <Badge tone={detail.draft ? 'neutral' : STATE_TONE[detail.state]}>{detail.draft ? 'Draft' : detail.state}</Badge>
                {checksFailed ? <Badge tone="destructive">Checks failing</Badge> : checksPending && bundle.checks.length > 0 ? <Badge tone="warning">Checks running</Badge> : bundle.checks.length > 0 ? <Badge tone="success">Checks passing</Badge> : null}
                <span className="ml-auto flex gap-1.5">
                  <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => { void load(); }}><RotateIcon size={11} /> Refresh</Button>
                  {linkedTask !== undefined ? <Button size="xs" variant="outline" onClick={() => { void openThread(linkedTask); }}>Open thread</Button> : null}
                  <Button size="xs" variant="outline" onClick={() => { void window.conductor.github.openPr(detail.url).catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); }); }}><ExternalLinkIcon size={11} /> GitHub</Button>
                </span>
              </div>
              <h1 className="text-lg font-semibold text-foreground">{detail.title} <span className="font-normal text-muted-foreground">#{detail.number}</span></h1>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{detail.author}</span> wants to merge
                {' '}<span className="font-mono">{detail.headBranch}</span> into <span className="font-mono">{detail.baseBranch}</span>
                {' '}· opened {relativeTime(detail.createdAt)} · updated {relativeTime(detail.updatedAt)}
                {' '}· <span className="text-success">+{detail.additions}</span> <span className="text-destructive-foreground">−{detail.deletions}</span>
                {' '}· {detail.changedFiles} file{detail.changedFiles === 1 ? '' : 's'} · {detail.commits} commit{detail.commits === 1 ? '' : 's'}
              </p>
              {detail.labels.length > 0 || detail.reviewers.length > 0 || detail.assignees.length > 0 ? (
                <p className="flex flex-wrap gap-1.5 text-2xs text-muted-foreground">
                  {detail.labels.map((l) => <Badge key={l}>{l}</Badge>)}
                  {detail.reviewers.length > 0 ? <span>Reviewers: {detail.reviewers.join(', ')}</span> : null}
                  {detail.assignees.length > 0 ? <span>Assignees: {detail.assignees.join(', ')}</span> : null}
                </p>
              ) : null}
            </header>

            <div role="tablist" aria-label="Pull request sections" className="flex gap-1 border-b border-border">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => { setTab(t.id); }}
                  className={cn('cursor-pointer border-b-2 px-3 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-ring', tab === t.id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                  {t.label}{t.id === 'files' ? ` (${bundle.files.length})` : t.id === 'commits' ? ` (${bundle.commits.length})` : t.id === 'conversation' ? ` (${bundle.comments.length})` : t.id === 'checks' ? ` (${bundle.checks.length})` : ''}
                </button>
              ))}
            </div>

            {tab === 'overview' ? <>
              <section aria-label="Description" className="rounded-xl border border-border bg-card px-4 py-3">
                {detail.body.trim() !== '' ? <Markdown text={detail.body} /> : <p className="text-sm text-muted-foreground">No description provided.</p>}
              </section>
              <section aria-label="Merge" className="rounded-xl border border-border bg-card px-4 py-3">
                {detail.state === 'merged' ? <p className="flex items-center gap-2 text-sm text-foreground"><PullRequestIcon size={15} className="text-violet-500" /> Merged{detail.mergedBy !== undefined ? ` by ${detail.mergedBy}` : ''}{detail.mergedAt !== undefined ? ` · ${relativeTime(detail.mergedAt)}` : ''}.</p>
                : detail.state === 'closed' ? <div className="flex flex-wrap items-center gap-2"><p className="flex-1 text-sm text-foreground">This pull request is closed.</p><Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void run('reopen', () => window.conductor.github.setPrState({ workspaceId, number, state: 'open' }), 'Pull request reopened.'); }}>Reopen</Button></div>
                : <>
                  <p className="text-sm font-medium text-foreground">{detail.draft ? 'Still a draft' : detail.mergeable === false ? 'This branch has conflicts' : detail.mergeable === null ? 'Checking if this branch can be merged…' : 'This branch can be merged'}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{detail.draft ? 'Draft pull requests cannot be merged.' : detail.mergeableState !== undefined ? `Merge status: ${detail.mergeableState.replaceAll('_', ' ')}.` : ''}{checksFailed ? ' Some checks are failing — review Checks before merging.' : ''}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Method
                      <select aria-label="Merge method" value={method} onChange={(e) => { setMethod(e.target.value as PrMergeMethod); }} className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground">
                        <option value="merge">Merge commit</option><option value="squash">Squash and merge</option><option value="rebase">Rebase and merge</option>
                      </select>
                    </label>
                    <Button size="sm" variant="primary" disabled={!canMerge || busy !== null} onClick={() => { setConfirmMerge(true); }}><CheckIcon size={12} /> Merge pull request</Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void run('approve', () => window.conductor.github.reviewPr({ workspaceId, number, event: 'APPROVE' }), 'Approved.'); }}>Approve</Button>
                    <Button size="sm" variant="destructive-outline" disabled={busy !== null} onClick={() => { void run('close', () => window.conductor.github.setPrState({ workspaceId, number, state: 'closed' }), 'Pull request closed.'); }}>Close</Button>
                  </div>
                </>}
              </section>
            </> : null}

            {tab === 'conversation' ? <>
              <ul className="flex flex-col gap-3">
                {bundle.comments.length === 0 ? <li className="text-sm text-muted-foreground">No comments yet.</li> : bundle.comments.map((c) => (
                  <li key={`${c.kind}:${c.id}`} className="rounded-xl border border-border bg-card px-4 py-3">
                    <p className="mb-1.5 text-xs text-muted-foreground"><span className="font-medium text-foreground">{c.author}</span> · {relativeTime(c.createdAt)}{c.kind === 'review' ? <> · review{c.reviewState !== undefined ? ` (${c.reviewState.toLowerCase().replaceAll('_', ' ')})` : ''}</> : ''}</p>
                    {c.body.trim() !== '' ? <Markdown text={c.body} /> : <p className="text-sm text-muted-foreground">(no comment text)</p>}
                  </li>
                ))}
              </ul>
              <section aria-label="Add a comment" className="rounded-xl border border-border bg-card px-4 py-3">
                <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-foreground">Leave a comment</span>
                  <textarea aria-label="Comment" rows={3} value={comment} onChange={(e) => { setComment(e.target.value); }} placeholder="Write a comment… (Markdown supported)" className={textareaClassName} />
                </label>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" disabled={comment.trim() === '' || busy !== null} onClick={() => { void run('comment', async () => { const next = await window.conductor.github.commentPr({ workspaceId, number, body: comment.trim() }); setComment(''); return next; }, 'Comment posted.'); }}>Comment</Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void run('approve', () => window.conductor.github.reviewPr({ workspaceId, number, event: 'APPROVE', ...(comment.trim() !== '' ? { body: comment.trim() } : {}) }), 'Approved.'); }}>Approve</Button>
                  <Button size="sm" variant="outline" disabled={comment.trim() === '' || busy !== null} onClick={() => { void run('request-changes', () => window.conductor.github.reviewPr({ workspaceId, number, event: 'REQUEST_CHANGES', body: comment.trim() }), 'Changes requested.'); }}>Request changes</Button>
                </div>
              </section>
            </> : null}

            {tab === 'commits' ? (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {bundle.commits.length === 0 ? <li className="px-4 py-3 text-sm text-muted-foreground">No commits.</li> : bundle.commits.map((c) => (
                  <li key={c.sha} className="flex items-baseline gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={c.message}>{c.message}</span>
                    <span className="shrink-0 text-2xs text-muted-foreground">{c.author}</span>
                    <span className="shrink-0 font-mono text-2xs text-muted-foreground">{c.sha.slice(0, 7)}</span>
                    <span className="shrink-0 text-2xs text-muted-foreground">{c.date !== '' ? relativeTime(c.date) : ''}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {tab === 'files' ? (
              <ul className="flex flex-col gap-2">
                {bundle.files.length === 0 ? <li className="text-sm text-muted-foreground">No files changed.</li> : bundle.files.map((f) => {
                  const expanded = expandedFiles.has(f.filename);
                  return (
                    <li key={f.filename} className="overflow-hidden rounded-xl border border-border bg-card">
                      <button type="button" aria-expanded={expanded} onClick={() => { setExpandedFiles((cur) => { const next = new Set(cur); if (next.has(f.filename)) next.delete(f.filename); else next.add(f.filename); return next; }); }}
                        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                        <ChevronRightIcon size={11} className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={f.filename}>{f.filename}</span>
                        <span className="shrink-0 text-2xs capitalize text-muted-foreground">{f.status}</span>
                        <span className="shrink-0 font-mono text-2xs"><span className="text-success">+{f.additions}</span> <span className="text-destructive-foreground">−{f.deletions}</span></span>
                      </button>
                      {expanded ? (f.patch !== undefined ? <PatchView patch={f.patch} /> : <p className="border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground">No textual diff (binary or too large for the GitHub API).</p>) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {tab === 'checks' ? (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {bundle.checks.length === 0 ? <li className="px-4 py-3 text-sm text-muted-foreground">No checks were reported for the latest commit.</li> : bundle.checks.map((c, i) => (
                  <li key={`${c.name}:${i}`} className="flex items-center gap-2 px-4 py-2.5 text-[13px]">
                    {c.conclusion === 'success' ? <CheckIcon size={13} className="text-success" /> : c.conclusion !== null ? <XIcon size={13} className="text-destructive" /> : <RotateIcon size={13} className="text-warning" />}
                    <span className="flex-1 text-foreground">{c.name}</span>
                    <span className="text-2xs text-muted-foreground">{c.status !== 'completed' ? c.status.replaceAll('_', ' ') : (c.conclusion ?? '')}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </> : null}
        </div>
      </div>

      <Dialog open={confirmMerge} onClose={() => { setConfirmMerge(false); }} title={`Merge pull request #${number}?`}
        description={`This merges ${detail?.headBranch ?? ''} into ${detail?.baseBranch ?? ''} on GitHub using “${method}”. This cannot be undone from Conductor.`}
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { setConfirmMerge(false); }}>Cancel</Button>
          <Button size="md" variant="primary" disabled={busy !== null} onClick={() => { setConfirmMerge(false); void run('merge', () => window.conductor.github.mergePr({ workspaceId, number, method }), 'Pull request merged.'); }}>
            {busy === 'merge' ? 'Merging…' : 'Confirm merge'}
          </Button>
        </>} />
    </div>
  );
}
