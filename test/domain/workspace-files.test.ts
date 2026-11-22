import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listWorkspaceFiles } from '@main/domain/workspace-files';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('workspace files for @-mentions', () => {
  it('lists files outside a git repo, skipping dependency folders, shortest paths first', async () => {
    root = mkdtempSync(join(tmpdir(), 'conductor-files-'));
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'x');
    writeFileSync(join(root, 'src', 'app.ts'), 'x');
    writeFileSync(join(root, 'src', 'deep', 'util.ts'), 'x');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    expect(await listWorkspaceFiles(root)).toEqual(['README.md', 'src/app.ts', 'src/deep/util.ts']);
  });
});
