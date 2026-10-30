import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ChangedFile,
  ChangedFileDiff,
  ChangedFileStatus,
  WorkspaceChanges,
} from '@shared/task-view';
import { redact } from '../ipc/redaction';

// Read-only Git queries behind the thread's Files panel. The renderer only
// ever sees paths relative to the workspace root, unified diffs capped to a
// bounded size, and redacted text. Nothing here writes to the repository or
// touches the network; Git runs with optional locks and terminal prompts off.

const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_DIFF_BYTES = 400 * 1024;
const GIT_TIMEOUT_MS = 15_000;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run Git in `cwd`, resolving the exit code instead of rejecting on non-zero. */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === 'number') {
          resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        reject(error);
      },
    );
  });
}

/** The work-tree prefix of `root` ('' at the repository root), or null outside Git. */
async function repositoryPrefix(root: string): Promise<string | null> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
  const prefix = await git(root, ['rev-parse', '--show-prefix']);
  return prefix.code === 0 ? prefix.stdout.trim() : '';
}

/** Convert a repository-relative path to one relative to the workspace root. */
function workspacePath(repositoryPath: string, prefix: string): string | null {
  if (prefix === '') return repositoryPath;
  if (!repositoryPath.startsWith(prefix)) return null;
  return repositoryPath.slice(prefix.length);
}

function statusFor(x: string, y: string): ChangedFileStatus {
  const pair = `${x}${y}`;
  if (pair === '??') return 'untracked';
  if (pair.includes('U') || pair === 'AA' || pair === 'DD') return 'conflicted';
  if (pair.includes('R') || pair.includes('C')) return 'renamed';
  if (pair.includes('A')) return 'added';
  if (pair.includes('D')) return 'deleted';
  return 'modified';
}

interface StatusEntry {
  path: string;
  previousPath?: string;
  status: ChangedFileStatus;
}

/** Parse `git status --porcelain=v1 -z` and keep only workspace-relative paths. */
function parseStatus(stdout: string, prefix: string): StatusEntry[] {
  const records = stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === '') continue;
    const x = record[0];
    const y = record[1];
    if (x === undefined || y === undefined || record[2] !== ' ') continue;
    const repositoryPath = record.slice(3);
    let repositoryPrevious: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      repositoryPrevious = records[++index];
      if (repositoryPrevious === undefined || repositoryPrevious === '') repositoryPrevious = undefined;
    }
    if (x === '!' && y === '!') continue; // ignored files never appear in changes
    const path = workspacePath(repositoryPath, prefix);
    if (path === null || path === '') continue;
    const previousPath = repositoryPrevious === undefined
      ? undefined
      : workspacePath(repositoryPrevious, prefix) ?? repositoryPrevious;
    entries.push({
      path,
      status: statusFor(x, y),
      ...(previousPath !== undefined ? { previousPath } : {}),
    });
  }
  return entries;
}

/** Parse `git diff --numstat -z --no-renames` into workspace-relative counts. */
function parseNumstat(stdout: string, prefix: string): Map<string, { additions?: number; deletions?: number }> {
  const counts = new Map<string, { additions?: number; deletions?: number }>();
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const path = workspacePath(parts.slice(2).join('\t'), prefix);
    if (path === null || path === '') continue;
    const additions = parts[0] !== '-' && parts[0] !== undefined ? Number(parts[0]) : undefined;
    const deletions = parts[1] !== '-' && parts[1] !== undefined ? Number(parts[1]) : undefined;
    counts.set(path, {
      ...(additions !== undefined && Number.isFinite(additions) ? { additions } : {}),
      ...(deletions !== undefined && Number.isFinite(deletions) ? { deletions } : {}),
    });
  }
  return counts;
}

export interface BranchBase {
  /** Merge-base commit of HEAD and the base branch. */
  ref: string;
  /** Display name of the base branch, e.g. `main` or `origin/main`. */
  name: string;
}

/**
 * The commit this branch forked from, so committed branch work stays visible
 * after it is committed/pushed (e.g. once a PR is raised and the worktree is
 * clean against HEAD). Tries origin's default branch first, then common base
 * branch names; the current branch itself is never its own base. Returns null
 * when HEAD has no commits ahead of any candidate.
 */
export async function branchBaseRef(root: string): Promise<BranchBase | null> {
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code !== 0) return null;
  const headSha = head.stdout.trim();
  const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const candidates: string[] = [];
  const originHead = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead.code === 0 && originHead.stdout.trim() !== '') candidates.push(originHead.stdout.trim());
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  for (const candidate of new Set(candidates)) {
    if (candidate === current || candidate === `origin/${current}`) continue;
    const exists = await git(root, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (exists.code !== 0) continue;
    const mergeBase = await git(root, ['merge-base', 'HEAD', candidate]);
    if (mergeBase.code !== 0) continue;
    const base = mergeBase.stdout.trim();
    if (base === '' || base === headSha) continue; // nothing committed ahead of the base
    return { ref: base, name: candidate.replace(/^origin\//, '') };
  }
  return null;
}

/** Parse `git diff --name-status -z <base> HEAD` into workspace-relative entries. */
function parseNameStatus(stdout: string, prefix: string): StatusEntry[] {
  const records = stdout.split('\0').filter((record) => record !== '');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index]!;
    const repositoryPath = records[++index];
    if (repositoryPath === undefined) break;
    let repositoryPrevious: string | undefined;
    if (code.startsWith('R') || code.startsWith('C')) {
      repositoryPrevious = repositoryPath;
      const renamed = records[++index];
      if (renamed === undefined) break;
      const path = workspacePath(renamed, prefix);
      if (path === null || path === '') continue;
      const previousPath = workspacePath(repositoryPrevious, prefix) ?? repositoryPrevious;
      entries.push({ path, status: 'renamed', previousPath });
      continue;
    }
    const path = workspacePath(repositoryPath, prefix);
    if (path === null || path === '') continue;
    const status: ChangedFileStatus = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
    entries.push({ path, status });
  }
  return entries;
}

/**
 * Files differing from HEAD (staged, unstaged, untracked, renamed) plus, when
 * this branch has commits ahead of its base branch, the committed branch
 * changes — so diffs remain visible after a PR is raised and the agent's work
 * is committed. A folder outside a Git work tree is an empty, non-error view.
 */
export async function listWorkspaceChanges(root: string): Promise<WorkspaceChanges> {
  const prefix = await repositoryPrefix(root);
  if (prefix === null) return { files: [], isRepository: false };

  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const [status, numstat] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['diff', '--numstat', '-z', '--no-renames', ...(head.code === 0 ? ['HEAD'] : ['--cached']), '--']),
  ]);
  if (status.code !== 0) {
    throw new Error(status.stderr.trim() || 'Could not read the project working tree');
  }

  // A repository with no commit has no HEAD; include unstaged edits too.
  const counts = parseNumstat(numstat.stdout, prefix);
  if (head.code !== 0) {
    const unstaged = await git(root, ['diff', '--numstat', '-z', '--no-renames', '--']);
    for (const [path, value] of parseNumstat(unstaged.stdout, prefix)) {
      const existing = counts.get(path);
      counts.set(path, {
        ...(existing?.additions !== undefined || value.additions !== undefined
          ? { additions: (existing?.additions ?? 0) + (value.additions ?? 0) }
          : {}),
        ...(existing?.deletions !== undefined || value.deletions !== undefined
          ? { deletions: (existing?.deletions ?? 0) + (value.deletions ?? 0) }
          : {}),
      });
    }
  }

  // Committed branch changes (e.g. after "File PR" committed the worktree):
  // diff the merge-base against the working tree so those files stay listed
  // with their full branch counts, merged under any uncommitted entries.
  const base = head.code === 0 ? await branchBaseRef(root) : null;
  let totalCounts = counts;
  const byPath = new Map<string, StatusEntry>();
  for (const entry of parseStatus(status.stdout, prefix)) byPath.set(entry.path, entry);
  if (base !== null) {
    const [nameStatus, baseNumstat] = await Promise.all([
      git(root, ['diff', '--name-status', '-z', '--no-renames', base.ref, 'HEAD', '--']),
      git(root, ['diff', '--numstat', '-z', '--no-renames', base.ref, '--']),
    ]);
    if (nameStatus.code === 0) {
      for (const entry of parseNameStatus(nameStatus.stdout, prefix)) {
        if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
      }
    }
    if (baseNumstat.code === 0) totalCounts = parseNumstat(baseNumstat.stdout, prefix);
  }

  const files: ChangedFile[] = [...byPath.values()].map((entry) => {
    const value = totalCounts.get(entry.path) ?? counts.get(entry.path);
    return {
      ...entry,
      ...(value?.additions !== undefined ? { additions: value.additions } : {}),
      ...(value?.deletions !== undefined ? { deletions: value.deletions } : {}),
    };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, isRepository: true, ...(base !== null ? { baseBranch: base.name } : {}) };
}

/** Resolve the request path inside the workspace and reject traversal/symlinks. */
function resolveWorkspacePath(root: string, path: string): { absolute: string; relative: string } {
  if (path.includes('\0') || isAbsolute(path)) throw new Error('Invalid file path');
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute);
  const escapes = relativePath === '..' || relativePath.startsWith(`..${sep}`);
  if (relativePath === '' || escapes || isAbsolute(relativePath)) {
    throw new Error('File must be inside the workspace');
  }
  return { absolute, relative: relativePath };
}

async function hasHead(root: string): Promise<boolean> {
  const result = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return result.code === 0;
}

/**
 * A unified diff for one changed path. Untracked files are diffed against
 * `/dev/null`; tracked files against HEAD (or the index before the first
 * commit). Output is bounded and redacted before crossing IPC.
 */
export async function readWorkspaceFileDiff(root: string, path: string): Promise<ChangedFileDiff> {
  const prefix = await repositoryPrefix(root);
  if (prefix === null) throw new Error('This project is not a Git repository');
  const target = resolveWorkspacePath(root, path);
  const pathRelative = target.relative.split(sep).join('/');

  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', pathRelative]);
  if (status.code !== 0) throw new Error(status.stderr.trim() || 'Could not read the file status');
  const untracked = status.stdout.startsWith('??');

  let patch = '';
  if (untracked) {
    let stats;
    try { stats = lstatSync(target.absolute); }
    catch { throw new Error('The file no longer exists'); }
    if (stats.isSymbolicLink()) throw new Error('Symbolic links have no text diff');
    const diff = await git(root, ['diff', '--no-index', '--no-color', '--no-textconv', '--unified=3', '--', '/dev/null', pathRelative]);
    if (diff.code > 1) throw new Error(diff.stderr.trim() || 'Could not read the file diff');
    patch = diff.stdout;
  } else if (await hasHead(root)) {
    // Diff from the branch's fork point when it has committed work ahead of
    // its base, so a file that was committed for a PR still shows its diff
    // even though it is clean against HEAD.
    const base = await branchBaseRef(root);
    const diff = await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--relative', '--unified=3', base?.ref ?? 'HEAD', '--', pathRelative]);
    if (diff.code !== 0) throw new Error(diff.stderr.trim() || 'Could not read the file diff');
    patch = diff.stdout;
  } else {
    const [staged, working] = await Promise.all([
      git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--relative', '--unified=3', '--cached', '--', pathRelative]),
      git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--relative', '--unified=3', '--', pathRelative]),
    ]);
    if (staged.code !== 0 || working.code !== 0) throw new Error(staged.stderr.trim() || working.stderr.trim() || 'Could not read the file diff');
    patch = [staged.stdout, working.stdout].filter((part) => part !== '').join('\n');
  }

  const truncated = Buffer.byteLength(patch, 'utf8') > MAX_DIFF_BYTES;
  const bounded = truncated
    ? Buffer.from(patch, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8')
    : patch;
  return { path: pathRelative, patch: redact(bounded) as string, truncated };
}
