import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureWorktree, removeWorktree, worktreeBranch, worktreePathFor } from '../../src/main/domain/worktree';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

describe('thread worktrees', () => {
  it('names branches and paths deterministically', () => {
    expect(worktreeBranch('abc-123 thread')).toBe('conductor/abc-123-thread');
    expect(worktreePathFor('/tmp/proj', 'abc')).toBe(join('/tmp', '.conductor-worktrees', 'proj-abc'));
  });

  it('creates a worktree before changes and reuses it for follow-ups', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-wt-'));
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');

    const first = await ensureWorktree(root, 'thread-1');
    expect(first).toMatchObject({ isRepository: true, created: true, branch: 'conductor/thread-1' });
    expect(git(first.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('conductor/thread-1');

    // A change in the worktree never appears in the user's checkout.
    writeFileSync(join(first.path, 'a.txt'), 'changed\n');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('base\n');
    expect(git(first.path, 'status', '--porcelain')).toContain('a.txt');

    const again = await ensureWorktree(root, 'thread-1');
    expect(again).toMatchObject({ path: first.path, created: false });

    await removeWorktree(root, 'thread-1');
    expect(existsSync(first.path)).toBe(false);
    expect(git(root, 'branch', '--list', 'conductor/thread-1')).toContain('conductor/thread-1');
  });

  it('runs non-Git folders in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-plain-'));
    await expect(ensureWorktree(root, 't1')).resolves.toMatchObject({ path: root, isRepository: false });
  });
});
