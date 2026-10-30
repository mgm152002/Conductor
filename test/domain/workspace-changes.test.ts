import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listWorkspaceChanges, readWorkspaceFileDiff } from '@main/domain/workspace-changes';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function git(...args: string[]): void {
  execFileSync('git', ['-C', root!, ...args], { stdio: 'pipe' });
}

function repoWithBranchCommit(): string {
  root = mkdtempSync(join(tmpdir(), 'conductor-changes-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'conductor/thread-1');
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'b.txt'), 'new file\n');
  // This is what "File PR" does: everything is committed, tree is clean.
  git('add', '-A'); git('commit', '-qm', 'thread work');
  return root;
}

describe('workspace changes after a PR is raised', () => {
  it('still lists committed branch files and their diffs when the tree is clean vs HEAD', async () => {
    const dir = repoWithBranchCommit();
    const changes = await listWorkspaceChanges(dir);
    expect(changes.baseBranch).toBe('main');
    expect(changes.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
    expect(changes.files.find((f) => f.path === 'a.txt')).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });

    const diff = await readWorkspaceFileDiff(dir, 'a.txt');
    expect(diff.patch).toContain('+two');
    const added = await readWorkspaceFileDiff(dir, 'b.txt');
    expect(added.patch).toContain('+new file');
  });

  it('still shows uncommitted edits on top of the committed branch work', async () => {
    const dir = repoWithBranchCommit();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'c.txt'), 'untracked\n');
    const changes = await listWorkspaceChanges(dir);
    expect(changes.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    const diff = await readWorkspaceFileDiff(dir, 'a.txt');
    expect(diff.patch).toContain('+three');
  });

  it('shows no committed changes on the base branch itself', async () => {
    const dir = repoWithBranchCommit();
    git('checkout', '-q', 'main');
    const changes = await listWorkspaceChanges(dir);
    expect(changes.files).toEqual([]);
    expect(changes.baseBranch).toBeUndefined();
  });
});
