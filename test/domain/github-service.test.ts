import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { GitHubService, parseGitHubRemote, pullRequestState } from '@main/domain/github-service';
import { worktreeBranch } from '@main/domain/worktree';
import type { Task } from '@shared/domain';

let root: string | undefined;
let store: SqliteStore | undefined;
afterEach(() => { store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

describe('parseGitHubRemote', () => {
  it('parses SSH and HTTPS remotes and rejects other hosts', () => {
    expect(parseGitHubRemote('git@github.com:acme/widgets.git')).toEqual({ owner: 'acme', name: 'widgets', fullName: 'acme/widgets' });
    expect(parseGitHubRemote('https://github.com/acme/widgets.git')).toEqual({ owner: 'acme', name: 'widgets', fullName: 'acme/widgets' });
    expect(parseGitHubRemote('https://github.com/acme/widgets')).toEqual({ owner: 'acme', name: 'widgets', fullName: 'acme/widgets' });
    expect(parseGitHubRemote('git@gitlab.com:acme/widgets.git')).toBeNull();
    expect(parseGitHubRemote('/local/path')).toBeNull();
  });
});

describe('pullRequestState', () => {
  it('treats merged_at as merged even when state is closed', () => {
    expect(pullRequestState({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' })).toBe('merged');
    expect(pullRequestState({ state: 'closed', merged_at: null })).toBe('closed');
    expect(pullRequestState({ state: 'open' })).toBe('open');
  });
});

async function seed() {
  root = mkdtempSync(join(tmpdir(), 'conductor-github-'));
  store = new SqliteStore(':memory:');
  await store.migrate();
  const s = store;
  const workspaces = new WorkspaceService(s);
  const project = workspaces.create({ name: 'Project', rootPath: root });
  const now = new Date().toISOString();
  const taskId = randomUUID();
  s.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, state, thread_id, created_at, updated_at) VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?)`)
    .run(taskId, project.id, 'Fix the thing', taskId, now, now);
  const secrets = new Map<string, string>();
  const opened: string[] = [];
  const apiPrs: unknown[] = [];
  const mergeCalls: { method?: string; body?: string }[] = [];
  let prMerged = false;
  const service = new GitHubService({
    store: s,
    workspaces,
    secrets: {
      put: async ({ value }: { value: string }) => { const id = `sec_${secrets.size}`; secrets.set(id, value); return { id, label: 't', createdAt: now }; },
      delete: async (id: string) => { secrets.delete(id); },
    } as never,
    resolveSecret: async (id) => secrets.get(id),
    getTask: (id) => {
      const row = s.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return {
        id: row['id'], workspaceId: row['workspace_id'], objective: row['objective'], state: row['state'],
        acceptanceCriteria: [], contextRefs: [], createdAt: row['created_at'], updatedAt: row['updated_at'],
        ...(row['pr_number'] ? { prNumber: row['pr_number'] as number } : {}),
        ...(row['pr_url'] ? { prUrl: row['pr_url'] as string } : {}),
        ...(row['pr_state'] ? { prState: row['pr_state'] as Task['prState'] } : {}),
      } as unknown as Task;
    },
    openExternal: async (url) => { opened.push(url); },
    fetchFn: (async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      if (url.includes('/pulls?state=all')) return new Response(JSON.stringify(apiPrs), { status: 200 });
      if (url.endsWith('/pulls/7/merge')) {
        mergeCalls.push({ ...(init?.method !== undefined ? { method: init.method } : {}), ...(init?.body !== undefined ? { body: init.body } : {}) });
        prMerged = true;
        return new Response(JSON.stringify({ merged: true, sha: 'abc123', message: 'Merged' }), { status: 200 });
      }
      if (url.endsWith('/pulls/7')) return new Response(JSON.stringify({
        number: 7, html_url: 'https://github.com/acme/widgets/pull/7', title: 'Reader PR',
        body: '## Summary\nDoes things', state: prMerged ? 'closed' : 'open', merged_at: prMerged ? '2026-01-03T00:00:00Z' : null,
        draft: false, mergeable: true, mergeable_state: 'clean', additions: 3, deletions: 1, changed_files: 1, commits: 1,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', user: { login: 'octocat' },
        merged_by: prMerged ? { login: 'octocat' } : null,
        head: { ref: 'conductor/x', sha: 'abc123' }, base: { ref: 'main' },
        labels: [{ name: 'bug' }], requested_reviewers: [{ login: 'reviewer1' }], assignees: [],
      }), { status: 200 });
      if (url.endsWith('/pulls/7/files?per_page=100')) return new Response(JSON.stringify([
        { filename: 'a.txt', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@ -1 +1 @@\n+new' },
      ]), { status: 200 });
      if (url.endsWith('/pulls/7/commits?per_page=100')) return new Response(JSON.stringify([
        { sha: 'abc123def', html_url: 'https://github.com/x', commit: { message: 'Do it\n\nbody', author: { name: 'Octo', date: '2026-01-01T00:00:00Z' } } },
      ]), { status: 200 });
      if (url.includes('/issues/7/comments')) return new Response(JSON.stringify([
        { id: 1, html_url: 'https://github.com/x#c1', body: 'Looks good', created_at: '2026-01-01T01:00:00Z', user: { login: 'reviewer1' } },
      ]), { status: 200 });
      if (url.endsWith('/pulls/7/reviews?per_page=100')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/commits/abc123/check-runs')) return new Response(JSON.stringify({
        check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/checks' }],
      }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
  });
  return { s, project, taskId, service, opened, secrets, apiPrs, mergeCalls };
}

describe('GitHubService connection', () => {
  it('validates the token, stores it as a secret, and reports status', async () => {
    const { project, service, secrets } = await seed();
    const status = await service.connect(project.id, 'ghp_test_token');
    expect(status.connected).toBe(true);
    expect(status.login).toBe('octocat');
    expect(status.repo).toBeNull(); // temp dir is not a git repository
    expect(secrets.size).toBe(1);
    expect(JSON.stringify(status)).not.toContain('ghp_test_token');

    const disconnected = await service.disconnect(project.id);
    expect(disconnected.connected).toBe(false);
    expect(secrets.size).toBe(0);
  });

  it('does not auto-PR when the project has not opted in', async () => {
    const { project, taskId, service } = await seed();
    await service.connect(project.id, 'ghp_test_token');
    const task = { id: taskId, workspaceId: project.id, threadId: taskId, state: 'COMPLETED' } as Task;
    await expect(service.autoPrForCompletedTask(task)).resolves.toBeUndefined();
    expect(service.listPrs(project.id)).toEqual([]);
  });
});

describe('GitHubService.refreshPrs', () => {
  it('syncs every PR on the repo, linking Conductor thread branches', async () => {
    const { s, project, taskId, service, apiPrs } = await seed();
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', root!]);
    execFileSync('git', ['-C', root!, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    await service.connect(project.id, 'ghp_test_token');
    apiPrs.push(
      { number: 11, html_url: 'https://github.com/acme/widgets/pull/11', title: 'Thread PR', state: 'open', merged_at: null, head: { ref: worktreeBranch(taskId) } },
      { number: 10, html_url: 'https://github.com/acme/widgets/pull/10', title: 'External PR', state: 'closed', merged_at: '2026-01-02T00:00:00Z', head: { ref: 'feature/manual' } },
    );
    const prs = await service.refreshPrs(project.id);
    expect(prs.map((pr) => pr.number)).toEqual([11, 10]);
    expect(prs[0]).toMatchObject({ threadKey: taskId, threadTitle: 'Fix the thing', state: 'open' });
    expect(prs[1]).toMatchObject({ threadKey: '', state: 'merged' });
    const rootRow = s.db.prepare('SELECT pr_number, pr_state FROM tasks WHERE id = ?').get(taskId) as { pr_number: number; pr_state: string };
    expect(rootRow).toEqual({ pr_number: 11, pr_state: 'open' });
  });
});

describe('GitHubService PR reader', () => {
  async function connected() {
    const ctx = await seed();
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', root!]);
    execFileSync('git', ['-C', root!, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    await ctx.service.connect(ctx.project.id, 'ghp_test_token');
    return ctx;
  }

  it('loads the full PR bundle for the reader tab', async () => {
    const { project, service } = await connected();
    const bundle = await service.getPr(project.id, 7);
    expect(bundle.detail).toMatchObject({
      number: 7, title: 'Reader PR', author: 'octocat', baseBranch: 'main', headBranch: 'conductor/x',
      mergeable: true, draft: false, labels: ['bug'], reviewers: ['reviewer1'], state: 'open',
    });
    expect(bundle.detail.body).toContain('Does things');
    expect(bundle.files).toEqual([expect.objectContaining({ filename: 'a.txt', patch: expect.stringContaining('+new') })]);
    expect(bundle.commits[0]).toMatchObject({ message: 'Do it', author: 'Octo' });
    expect(bundle.comments[0]).toMatchObject({ author: 'reviewer1', body: 'Looks good', kind: 'comment' });
    expect(bundle.checks).toEqual([expect.objectContaining({ name: 'test', conclusion: 'success' })]);
  });

  it('merges from Conductor and returns the updated (merged) bundle', async () => {
    const { s, project, taskId, service, mergeCalls } = await connected();
    const now = new Date().toISOString();
    s.db.prepare(`INSERT INTO github_pull_requests (id, workspace_id, thread_key, root_task_id, number, url, title, branch, state, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 7, 'https://github.com/acme/widgets/pull/7', 'Reader PR', 'conductor/x', 'open', ?, ?)`)
      .run(randomUUID(), project.id, taskId, taskId, now, now);
    const bundle = await service.mergePr(project.id, 7, 'squash');
    expect(mergeCalls).toEqual([{ method: 'PUT', body: JSON.stringify({ merge_method: 'squash' }) }]);
    expect(bundle.detail.state).toBe('merged');
    expect(bundle.detail.mergedBy).toBe('octocat');
    const row = s.db.prepare('SELECT pr_state FROM tasks WHERE id = ?').get(taskId) as { pr_state: string };
    expect(row.pr_state).toBe('merged');
  });
});

describe('GitHubService.openPr', () => {
  it('opens only PR URLs Conductor persisted', async () => {
    const { s, project, taskId, service, opened } = await seed();
    await expect(service.openPr('https://github.com/acme/widgets/pull/9')).rejects.toThrow(/Unknown pull request/);
    await expect(service.openPr('https://example.com/phish')).rejects.toThrow(/github\.com/);
    s.db.prepare('UPDATE tasks SET pr_number = 9, pr_url = ?, pr_state = ? WHERE id = ?')
      .run('https://github.com/acme/widgets/pull/9', 'open', taskId);
    void project;
    await service.openPr('https://github.com/acme/widgets/pull/9');
    expect(opened).toEqual(['https://github.com/acme/widgets/pull/9']);
  });

  it('lists recorded PRs with their thread title', async () => {
    const { s, project, taskId, service } = await seed();
    const now = new Date().toISOString();
    s.db.prepare(`INSERT INTO github_pull_requests (id, workspace_id, thread_key, root_task_id, number, url, title, branch, state, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 9, 'https://github.com/acme/widgets/pull/9', 'Fix the thing', 'conductor/x', 'merged', ?, ?)`)
      .run(randomUUID(), project.id, taskId, taskId, now, now);
    const prs = service.listPrs(project.id);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 9, state: 'merged', threadTitle: 'Fix the thing', threadKey: taskId });
  });
});
