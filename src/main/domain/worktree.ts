import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Every Work thread runs inside its own Git worktree, created before the
// agent starts, so agent changes never touch the user's checkout until they
// choose to merge the thread branch. Worktrees live beside the project
// (`<parent>/.conductor-worktrees/<repo>-<thread>`), never inside it, so the
// main checkout's status stays clean. Non-Git folders keep running in place.

export interface WorktreeInfo {
  path: string;
  branch?: string;
  isRepository: boolean;
  created: boolean;
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      if (error === null) { resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) }); return; }
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === 'number') { resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) }); return; }
      reject(error);
    });
  });
}

/** Branch name for a thread, e.g. `conductor/3fa9c1e2`. */
export function worktreeBranch(threadKey: string): string {
  const safe = threadKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'thread';
  return `conductor/${safe}`;
}

/** Deterministic worktree location for a project root + thread. */
export function worktreePathFor(root: string, threadKey: string): string {
  const safe = threadKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'thread';
  return join(dirname(root), '.conductor-worktrees', `${basename(root)}-${safe}`);
}

/**
 * Create (or reuse) the worktree for a thread. Reuse is keyed on the path
 * already being a registered worktree on the expected branch, so follow-up
 * messages in the same thread keep working on the same files.
 */
export async function ensureWorktree(root: string, threadKey: string): Promise<WorktreeInfo> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']).catch(() => null);
  if (inside === null || inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { path: root, isRepository: false, created: false };
  }
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code !== 0) return { path: root, isRepository: true, created: false }; // no commit yet: nothing to branch from

  const branch = worktreeBranch(threadKey);
  const path = worktreePathFor(root, threadKey);
  if (existsSync(path)) {
    const branchThere = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
    if (branchThere !== null && branchThere.code === 0) return { path, branch, isRepository: true, created: false };
  }
  const branchExists = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  const added = branchExists
    ? await git(root, ['worktree', 'add', path, branch])
    : await git(root, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  if (added.code !== 0) {
    // A concurrent first message may have created it a moment earlier.
    if (existsSync(path)) return { path, branch, isRepository: true, created: false };
    throw new Error(added.stderr.trim() || 'Could not create the thread worktree');
  }
  return { path, branch, isRepository: true, created: true };
}

/** Remove a thread's worktree (branch is kept so work stays recoverable). */
export async function removeWorktree(root: string, threadKey: string): Promise<void> {
  const path = worktreePathFor(root, threadKey);
  if (!existsSync(path)) return;
  await git(root, ['worktree', 'remove', '--force', path]).catch(() => undefined);
  await git(root, ['worktree', 'prune']).catch(() => undefined);
}
