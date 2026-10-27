import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listWorkspaceChanges, readWorkspaceFileDiff } from '@main/domain/workspace-changes';

const hasGit = ((): boolean => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'conductor-changes-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  return root;
}

describe.skipIf(!hasGit)('workspace changes', () => {
  it('lists staged, unstaged, untracked, deleted and renamed files with counts', async () => {
    const root = repository();
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(root, 'c.txt'), 'old\n');
    writeFileSync(join(root, 'd.txt'), 'rename me\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');

    writeFileSync(join(root, 'a.txt'), 'one\nTWO\n');
    writeFileSync(join(root, 'b.txt'), 'untracked\n');
    rmSync(join(root, 'c.txt'));
    git(root, 'mv', 'd.txt', 'e.txt');

    const changes = await listWorkspaceChanges(root);
    expect(changes.isRepository).toBe(true);
    const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file]));
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(byPath['b.txt']).toMatchObject({ status: 'untracked' });
    expect(byPath['c.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(byPath['e.txt']).toMatchObject({ status: 'renamed', previousPath: 'd.txt', additions: 1, deletions: 0 });
    expect(changes.files.map((file) => file.path)).toEqual([...changes.files.map((file) => file.path)].sort());
  });

  it('reads unified diffs for modified, deleted and untracked files', async () => {
    const root = repository();
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(root, 'c.txt'), 'old\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    writeFileSync(join(root, 'a.txt'), 'one\nTWO\n');
    writeFileSync(join(root, 'b.txt'), 'untracked\n');
    rmSync(join(root, 'c.txt'));

    const modified = await readWorkspaceFileDiff(root, 'a.txt');
    expect(modified.truncated).toBe(false);
    expect(modified.patch).toContain('+TWO');
    expect(modified.patch).toContain('-two');

    const untracked = await readWorkspaceFileDiff(root, 'b.txt');
    expect(untracked.patch).toContain('+untracked');

    const deleted = await readWorkspaceFileDiff(root, 'c.txt');
    expect(deleted.patch).toContain('-old');
  });

  it('keeps diffs inside the workspace and redacts credentials', async () => {
    const root = repository();
    writeFileSync(join(root, 'keep.txt'), 'ok\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    writeFileSync(join(root, 'secret.txt'), 'API_KEY=supersecretvalue123\n');

    await expect(readWorkspaceFileDiff(root, '../outside.txt')).rejects.toThrow('inside the workspace');
    await expect(readWorkspaceFileDiff(root, '/etc/passwd')).rejects.toThrow('Invalid file path');

    // A dot-prefixed name inside the workspace is not traversal.
    writeFileSync(join(root, '..notes.txt'), 'safe\n');
    const dotted = await readWorkspaceFileDiff(root, '..notes.txt');
    expect(dotted.patch).toContain('+safe');

    const secret = await readWorkspaceFileDiff(root, 'secret.txt');
    expect(secret.patch).not.toContain('supersecretvalue123');
    expect(secret.patch).toContain('[REDACTED]');
  });

  it('treats a folder outside Git as an empty view', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-no-git-'));
    roots.push(root);
    writeFileSync(join(root, 'plain.txt'), 'hello\n');
    await expect(listWorkspaceChanges(root)).resolves.toEqual({ files: [], isRepository: false });
    await expect(readWorkspaceFileDiff(root, 'plain.txt')).rejects.toThrow('not a Git repository');
  });

  it('scopes a project nested inside a larger repository to the project folder', async () => {
    const root = repository();
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'root.txt'), 'root\n');
    writeFileSync(join(nested, 'inside.txt'), 'old\n');
    writeFileSync(join(nested, 'other.txt'), 'other\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');

    writeFileSync(join(root, 'root.txt'), 'root changed\n');
    writeFileSync(join(nested, 'inside.txt'), 'new\n');
    writeFileSync(join(nested, 'added.txt'), 'extra\n');

    const changes = await listWorkspaceChanges(nested);
    expect(changes.isRepository).toBe(true);
    expect(changes.files.map((file) => file.path).sort()).toEqual(['added.txt', 'inside.txt']);
    const inside = await readWorkspaceFileDiff(nested, 'inside.txt');
    expect(inside.path).toBe('inside.txt');
    expect(inside.patch).toContain('+new');
  });

  it('reports changes before the first commit', async () => {
    const root = repository();
    writeFileSync(join(root, 'staged.txt'), 'one\n');
    writeFileSync(join(root, 'mixed.txt'), 'one\n');
    git(root, 'add', 'staged.txt', 'mixed.txt');
    writeFileSync(join(root, 'mixed.txt'), 'one\ntwo\n');

    const changes = await listWorkspaceChanges(root);
    const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file]));
    expect(byPath['staged.txt']).toMatchObject({ status: 'added', additions: 1 });
    expect(byPath['mixed.txt']).toMatchObject({ status: 'added', additions: 2 });

    const diff = await readWorkspaceFileDiff(root, 'mixed.txt');
    expect(diff.patch).toContain('+one');
    expect(diff.patch).toContain('+two');
  });

  it('does not follow an untracked symlink when reading a diff', async () => {
    const root = repository();
    symlinkSync('/etc/passwd', join(root, 'link.txt'));

    const changes = await listWorkspaceChanges(root);
    expect(changes.files.find((file) => file.path === 'link.txt')).toMatchObject({ status: 'untracked' });
    await expect(readWorkspaceFileDiff(root, 'link.txt')).rejects.toThrow('Symbolic links');
  });

  it('caps very large diffs', async () => {
    const root = repository();
    writeFileSync(join(root, 'large.txt'), `${'x'.repeat(120)}\n`.repeat(5_000));

    const diff = await readWorkspaceFileDiff(root, 'large.txt');
    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.patch, 'utf8')).toBeLessThanOrEqual(400 * 1024);
  });
});
