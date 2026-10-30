import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Store } from '../db/types';
import type { Task } from '@shared/domain';
import type { CreatePrResult, GitHubConnectionStatus, GitHubRepoRef, PullRequestRecord, PullRequestState } from '@shared/github-contract';
import type { WorkspaceService } from './workspace-service';
import type { SecretStore } from '../secrets/secret-store';
import { worktreeBranch, worktreePathFor } from './worktree';

// Per-project GitHub integration. A project's repository is detected from
// its git `origin` remote; the user's personal access token lives in the
// macOS Keychain (metadata + login in preferences). When a Work agent
// finishes, the thread's worktree is committed, its branch pushed, and a
// pull request opened through the GitHub API and linked to the thread.

const API = 'https://api.github.com';

export interface GitHubServiceDeps {
  store: Store;
  workspaces: WorkspaceService;
  secrets: SecretStore;
  resolveSecret: (secretId: string) => Promise<string | undefined>;
  getTask: (taskId: string) => Task | undefined;
  onTaskUpdated?: (task: Task) => void;
  openExternal: (url: string) => Promise<void>;
  fetchFn?: typeof fetch;
}

/** Parse a GitHub `origin` remote URL (SSH or HTTPS) into owner/name. */
export function parseGitHubRemote(remote: string): GitHubRepoRef | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(trimmed);
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/.*)?$/.exec(trimmed);
  const match = ssh ?? https;
  if (match === null) return null;
  const owner = match[1]!;
  const name = match[2]!;
  return { owner, name, fullName: `${owner}/${name}` };
}

/** GitHub reports merged PRs as closed with `merged_at` set. */
export function pullRequestState(pr: { state?: string; merged_at?: string | null }): PullRequestState {
  if (pr.merged_at) return 'merged';
  return pr.state === 'closed' ? 'closed' : 'open';
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      if (error === null) { resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) }); return; }
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === 'number') { resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) }); return; }
      reject(error);
    });
  });
}

function firstLine(text: string, limit = 120): string {
  const line = text.trim().split('\n').find((entry) => entry.trim() !== '') ?? 'Conductor thread';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

interface PrRow {
  id: string; workspace_id: string; thread_key: string; root_task_id: string;
  number: number; url: string; title: string; branch: string; state: string;
  created_at: string; updated_at: string;
}

export class GitHubService {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: GitHubServiceDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  // -- preferences (workspace-scoped, alongside SettingsService rows) -------

  private pref(workspaceId: string, key: string): string | undefined {
    const row = this.deps.store.db.prepare(
      'SELECT value_json FROM preferences WHERE scope = ? AND workspace_id = ? AND key = ?',
    ).get('workspace', workspaceId, `github.${key}`) as { value_json: string } | undefined;
    if (row === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(row.value_json);
      return typeof value === 'string' ? value : undefined;
    } catch { return undefined; }
  }

  private setPref(workspaceId: string, key: string, value: string | undefined): void {
    if (value === undefined) {
      this.deps.store.db.prepare('DELETE FROM preferences WHERE scope = ? AND workspace_id = ? AND key = ?')
        .run('workspace', workspaceId, `github.${key}`);
      return;
    }
    this.deps.store.db.prepare(
      `INSERT INTO preferences (scope, workspace_id, key, value_json) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, workspace_id, key) DO UPDATE SET value_json = excluded.value_json`,
    ).run('workspace', workspaceId, `github.${key}`, JSON.stringify(value));
  }

  // -- connection -----------------------------------------------------------

  private async repoFor(rootPath: string): Promise<GitHubRepoRef | null> {
    const remote = await git(rootPath, ['remote', 'get-url', 'origin']).catch(() => null);
    if (remote === null || remote.code !== 0) return null;
    return parseGitHubRemote(remote.stdout);
  }

  private async token(workspaceId: string): Promise<string | undefined> {
    const secretId = this.pref(workspaceId, 'secretId');
    if (secretId === undefined) return undefined;
    return this.deps.resolveSecret(secretId);
  }

  async status(workspaceId: string): Promise<GitHubConnectionStatus> {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error('Project not found');
    const repo = await this.repoFor(workspace.rootPath);
    const login = this.pref(workspaceId, 'login');
    const lastError = this.pref(workspaceId, 'lastError');
    const lastErrorAt = this.pref(workspaceId, 'lastErrorAt');
    const baseBranch = this.pref(workspaceId, 'baseBranch');
    return {
      workspaceId,
      repo,
      connected: this.pref(workspaceId, 'secretId') !== undefined,
      ...(login !== undefined ? { login } : {}),
      autoPr: this.pref(workspaceId, 'autoPr') === 'true',
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(lastError !== undefined ? { lastError, ...(lastErrorAt !== undefined ? { lastErrorAt } : {}) } : {}),
    };
  }

  private async api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchFn(`${API}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = text === '' ? null : JSON.parse(text); } catch { body = null; }
    if (!response.ok) {
      const message = (body as { message?: string } | null)?.message ?? text.slice(0, 200);
      throw new Error(`GitHub API ${response.status}: ${message}`.replaceAll(token, '***'));
    }
    return body as T;
  }

  async connect(workspaceId: string, token: string): Promise<GitHubConnectionStatus> {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error('Project not found');
    const user = await this.api<{ login: string }>(token, '/user');
    const previous = this.pref(workspaceId, 'secretId');
    if (previous !== undefined) await this.deps.secrets.delete(previous).catch(() => undefined);
    const secret = await this.deps.secrets.put({
      label: `GitHub token · ${workspace.name}`,
      value: token,
      owner: `github:${workspaceId}`,
    });
    this.setPref(workspaceId, 'secretId', secret.id);
    this.setPref(workspaceId, 'login', user.login);
    this.setPref(workspaceId, 'lastError', undefined);
    return this.status(workspaceId);
  }

  async disconnect(workspaceId: string): Promise<GitHubConnectionStatus> {
    const secretId = this.pref(workspaceId, 'secretId');
    if (secretId !== undefined) await this.deps.secrets.delete(secretId).catch(() => undefined);
    for (const key of ['secretId', 'login', 'lastError', 'lastErrorAt']) this.setPref(workspaceId, key, undefined);
    return this.status(workspaceId);
  }

  async setAutoPr(workspaceId: string, enabled: boolean): Promise<GitHubConnectionStatus> {
    this.setPref(workspaceId, 'autoPr', enabled ? 'true' : 'false');
    return this.status(workspaceId);
  }

  async setBaseBranch(workspaceId: string, branch: string): Promise<GitHubConnectionStatus> {
    this.setPref(workspaceId, 'baseBranch', branch === '' ? undefined : branch);
    return this.status(workspaceId);
  }

  // -- pull requests ----------------------------------------------------------

  private async requireConnection(workspaceId: string): Promise<{ rootPath: string; repo: GitHubRepoRef; token: string }> {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error('Project not found');
    const repo = await this.repoFor(workspace.rootPath);
    if (repo === null) throw new Error('This project has no GitHub `origin` remote, so no pull request can be opened.');
    const token = await this.token(workspaceId);
    if (token === undefined) throw new Error('GitHub is not connected for this project. Connect it in Settings → GitHub.');
    return { rootPath: workspace.rootPath, repo, token };
  }

  private toRecord(row: PrRow): PullRequestRecord {
    const root = this.deps.getTask(row.root_task_id);
    return {
      id: row.id, workspaceId: row.workspace_id, threadKey: row.thread_key,
      number: row.number, url: row.url, title: row.title, branch: row.branch,
      state: row.state as PullRequestState,
      threadTitle: root !== undefined ? (root.title ?? firstLine(root.objective, 80)) : row.title,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  listPrs(workspaceId: string): PullRequestRecord[] {
    const rows = this.deps.store.db.prepare(
      'SELECT * FROM github_pull_requests WHERE workspace_id = ? ORDER BY number DESC',
    ).all(workspaceId) as PrRow[];
    return rows.map((row) => this.toRecord(row));
  }

  private savePr(workspaceId: string, threadKey: string, pr: { number: number; url: string; title: string; branch: string; state: PullRequestState }): PullRequestRecord {
    const now = new Date().toISOString();
    const existing = this.deps.store.db.prepare(
      'SELECT * FROM github_pull_requests WHERE workspace_id = ? AND number = ?',
    ).get(workspaceId, pr.number) as PrRow | undefined;
    if (existing !== undefined) {
      this.deps.store.db.prepare('UPDATE github_pull_requests SET url = ?, title = ?, branch = ?, state = ?, thread_key = ?, updated_at = ? WHERE id = ?')
        .run(pr.url, pr.title, pr.branch, pr.state, threadKey, now, existing.id);
    } else {
      this.deps.store.db.prepare(
        'INSERT INTO github_pull_requests (id, workspace_id, thread_key, root_task_id, number, url, title, branch, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(randomUUID(), workspaceId, threadKey, threadKey, pr.number, pr.url, pr.title, pr.branch, pr.state, now, now);
    }
    // Mirror onto the thread's root task so sidebar/header render without a join.
    this.deps.store.db.prepare('UPDATE tasks SET pr_number = ?, pr_url = ?, pr_state = ? WHERE id = ?')
      .run(pr.number, pr.url, pr.state, threadKey);
    const root = this.deps.getTask(threadKey);
    if (root !== undefined) this.deps.onTaskUpdated?.(root);
    const row = this.deps.store.db.prepare('SELECT * FROM github_pull_requests WHERE workspace_id = ? AND number = ?')
      .get(workspaceId, pr.number) as PrRow;
    return this.toRecord(row);
  }

  async createPrForThread(workspaceId: string, threadKey: string): Promise<CreatePrResult> {
    const root = this.deps.getTask(threadKey);
    if (root === undefined || root.workspaceId !== workspaceId) throw new Error('Thread not found in this project');
    const { rootPath, repo, token } = await this.requireConnection(workspaceId);
    const branch = worktreeBranch(threadKey);
    const worktree = worktreePathFor(rootPath, threadKey);
    if (!existsSync(worktree)) throw new Error('This thread has no worktree yet, so there is no branch to open a PR from.');
    const title = root.title ?? firstLine(root.objective);
    const clean = (text: string): string => text.replaceAll(token, '***');

    // Commit whatever the agent left in the worktree.
    const dirty = await git(worktree, ['status', '--porcelain']);
    if (dirty.code !== 0) throw new Error(clean(dirty.stderr.trim() || 'Could not inspect the thread worktree'));
    if (dirty.stdout.trim() !== '') {
      const add = await git(worktree, ['add', '-A']);
      if (add.code !== 0) throw new Error(clean(add.stderr.trim() || 'git add failed'));
      const commit = await git(worktree, ['-c', 'user.name=Conductor', '-c', 'user.email=conductor@localhost', 'commit', '-m', title]);
      if (commit.code !== 0) throw new Error(clean(commit.stderr.trim() || 'git commit failed'));
    }

    const base = this.pref(workspaceId, 'baseBranch')
      ?? (await this.api<{ default_branch: string }>(token, `/repos/${repo.fullName}`)).default_branch;
    const authRemote = `https://x-access-token:${token}@github.com/${repo.fullName}.git`;
    const fetched = await git(worktree, ['fetch', authRemote, base]);
    if (fetched.code !== 0) throw new Error(clean(fetched.stderr.trim() || `Could not fetch ${base} from GitHub`));
    const ahead = await git(worktree, ['rev-list', '--count', 'FETCH_HEAD..HEAD']);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) === 0) {
      const existing = this.listPrs(workspaceId).find((pr) => pr.threadKey === threadKey);
      if (existing !== undefined) return { status: 'existing', pr: existing };
      return { status: 'no-changes', branch };
    }
    const push = await git(worktree, ['push', authRemote, `HEAD:${branch}`]);
    if (push.code !== 0) throw new Error(clean(push.stderr.trim() || 'git push failed'));

    let created: { number: number; html_url: string; title: string; state: string; merged_at?: string | null };
    try {
      created = await this.api(token, `/repos/${repo.fullName}/pulls`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          head: branch,
          base,
          body: `Opened by Conductor from a Work thread.\n\n${root.objective}`,
        }),
      });
    } catch (error) {
      // A PR for this branch may already exist (e.g. a follow-up message
      // finished): reuse it instead of failing the thread.
      const list = await this.api<typeof created[]>(token, `/repos/${repo.fullName}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`).catch(() => []);
      const found = list[0];
      if (found === undefined) throw error;
      created = found;
    }
    const pr = this.savePr(workspaceId, threadKey, {
      number: created.number, url: created.html_url, title: created.title, branch,
      state: pullRequestState(created),
    });
    this.setPref(workspaceId, 'lastError', undefined);
    return { status: 'created', pr };
  }

  /**
   * Sync every pull request on the repository (not just ones Conductor
   * filed) into the local table, then return the full list. PRs whose head
   * branch is a Conductor thread branch are linked to that thread; others
   * are recorded unlinked so the project PR view is complete.
   */
  async refreshPrs(workspaceId: string): Promise<PullRequestRecord[]> {
    const { repo, token } = await this.requireConnection(workspaceId);
    interface ApiPr { number: number; html_url: string; title: string; state: string; merged_at?: string | null; head?: { ref?: string } }
    const all: ApiPr[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const batch = await this.api<ApiPr[]>(token, `/repos/${repo.fullName}/pulls?state=all&per_page=100&page=${page}&sort=updated&direction=desc`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    // Thread branches are `conductor/<sanitized thread key>`; map them back
    // to root tasks in this workspace so synced PRs link to their thread.
    const roots = this.deps.store.db.prepare('SELECT id FROM tasks WHERE workspace_id = ? AND (thread_id IS NULL OR thread_id = id)')
      .all(workspaceId) as { id: string }[];
    const threadByBranch = new Map(roots.map((row) => [worktreeBranch(row.id), row.id]));
    const knownThreads = new Map(this.listPrs(workspaceId).map((pr) => [pr.number, pr.threadKey]));
    for (const pr of all) {
      const branch = pr.head?.ref ?? '';
      const threadKey = knownThreads.get(pr.number) ?? threadByBranch.get(branch) ?? '';
      const now = new Date().toISOString();
      const state = pullRequestState(pr);
      const existing = this.deps.store.db.prepare('SELECT * FROM github_pull_requests WHERE workspace_id = ? AND number = ?')
        .get(workspaceId, pr.number) as PrRow | undefined;
      if (existing !== undefined) {
        this.deps.store.db.prepare('UPDATE github_pull_requests SET url = ?, title = ?, branch = ?, state = ?, thread_key = CASE WHEN thread_key = \'\' THEN ? ELSE thread_key END, root_task_id = CASE WHEN root_task_id = \'\' THEN ? ELSE root_task_id END, updated_at = ? WHERE id = ?')
          .run(pr.html_url, pr.title, branch, state, threadKey, threadKey, now, existing.id);
      } else {
        this.deps.store.db.prepare(
          'INSERT INTO github_pull_requests (id, workspace_id, thread_key, root_task_id, number, url, title, branch, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(randomUUID(), workspaceId, threadKey, threadKey, pr.number, pr.html_url, pr.title, branch, state, now, now);
      }
      if (threadKey !== '') {
        this.deps.store.db.prepare('UPDATE tasks SET pr_number = ?, pr_url = ?, pr_state = ? WHERE id = ?')
          .run(pr.number, pr.html_url, state, threadKey);
        const root = this.deps.getTask(threadKey);
        if (root !== undefined) this.deps.onTaskUpdated?.(root);
      }
    }
    return this.listPrs(workspaceId);
  }

  /** Open a PR URL in the browser; only URLs Conductor itself persisted. */
  async openPr(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') throw new Error('Only github.com pull request links can be opened');
    const known = this.deps.store.db.prepare(
      'SELECT id FROM github_pull_requests WHERE url = ? UNION SELECT id FROM tasks WHERE pr_url = ? LIMIT 1',
    ).get(url, url) as { id: string } | undefined;
    if (known === undefined) throw new Error('Unknown pull request link');
    await this.deps.openExternal(url);
  }

  /** Fire-and-forget hook for task completion; failures stay visible in Settings. */
  async autoPrForCompletedTask(task: Task): Promise<void> {
    if (task.state !== 'COMPLETED') return;
    const workspaceId = task.workspaceId;
    if (this.pref(workspaceId, 'autoPr') !== 'true') return;
    if (this.pref(workspaceId, 'secretId') === undefined) return;
    try {
      await this.createPrForThread(workspaceId, task.threadId ?? task.id);
      this.setPref(workspaceId, 'lastError', undefined);
    } catch (error) {
      this.setPref(workspaceId, 'lastError', error instanceof Error ? error.message : String(error));
      this.setPref(workspaceId, 'lastErrorAt', new Date().toISOString());
    }
  }
}
