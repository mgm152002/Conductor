import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// The project's files, for @-mentions in the composers. Paths are relative to
// the workspace root. Git's view is used when the folder is a repository (it
// already honours .gitignore); otherwise a bounded walk that skips the usual
// heavy folders.

/** At most this many paths are returned. */
export const MAX_WORKSPACE_FILES = 20_000;
const SKIPPED = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.cache', 'coverage', '.venv', 'venv', '__pycache__', 'target', '.turbo']);

function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => { resolve(error ? null : stdout.split('\0').filter((path) => path !== '')); });
  });
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < MAX_WORKSPACE_FILES) {
    const dir = queue.shift()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED.has(entry.name)) queue.push(path); }
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
      if (files.length >= MAX_WORKSPACE_FILES) break;
    }
  }
  return files;
}

/** Relative paths of the files in a workspace, shortest first. */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const files = (await gitFiles(root)) ?? await walk(root);
  return [...new Set(files)]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, MAX_WORKSPACE_FILES);
}
