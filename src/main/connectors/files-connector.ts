import { constants } from 'node:fs';
import { access, lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  Connector,
  ConnectorLifecycle,
  RetrieveResult,
  RetrievedItem,
} from '@shared/connector';

// A local folder connector (kind `files`). It indexes readable text files under
// one configured root so their content becomes searchable memory and task
// context for the bound project.
//
// Safety boundaries:
//  * read-only: the connector never writes to the folder;
//  * containment: symlinks are not followed, so nothing outside the root is read;
//  * likely-secret files are skipped (dotfiles such as .env, key/cert material);
//  * binary files, very large files and dependency/build folders are skipped;
//  * a sync processes a bounded batch and advances an mtime cursor, so large
//    folders are indexed incrementally across syncs without blocking.

/** Directory names that are never descended into. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target',
  'coverage', '__pycache__', 'venv', 'env', 'Pods', 'DerivedData', 'tmp', 'temp',
  'logs',
]);

/** Extensions considered indexable text. Anything else is skipped. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.org',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.csv', '.tsv',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.m', '.mm',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.lua', '.r', '.scala',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql', '.gql', '.proto',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro',
  '.dart', '.ex', '.exs', '.erl', '.hs', '.clj', '.elm', '.tf', '.hcl', '.gradle',
]);

/** File names skipped regardless of extension because they commonly hold secrets. */
const SECRET_NAME = /(^|[._-])(secret|secrets|credential|credentials|private[-_]?key|id_rsa|id_ed25519)([._-]|$)/i;

/** Lock files are large, generated and add no useful context. */
const SKIPPED_FILES: ReadonlySet<string> = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock',
  'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
]);

export interface FilesConnectorOptions {
  /** Max bytes read per file; larger files are skipped. Default 256 KiB. */
  maxFileBytes?: number;
  /**
   * Max new/changed files returned per sync. Default 50: the cursor only
   * advances once a batch is fully ingested, so smaller batches checkpoint
   * progress (and bound re-reads after a failure or restart) far more often.
   * The runtime drains successive batches within one sync request.
   */
  maxItemsPerSync?: number;
  /** Max directory entries visited per sync, bounding huge trees. Default 50k. */
  maxEntriesScanned?: number;
}

interface Candidate {
  absolute: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
}

interface FilesCursor {
  v: 1;
  /** Highest mtime (ms) fully ingested so far. */
  mtimeMs: number;
}

export function parseFilesCursor(cursor: string | undefined): FilesCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(cursor) as Partial<FilesCursor>;
    return parsed.v === 1 && typeof parsed.mtimeMs === 'number' ? { v: 1, mtimeMs: parsed.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

/** True when a path segment should be excluded from indexing. */
export function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name);
}

/** True when a file name is eligible for indexing (before size/binary checks). */
export function isIndexableFile(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (SKIPPED_FILES.has(name)) return false;
  if (SECRET_NAME.test(name)) return false;
  if (/\.(pem|key|p12|pfx|crt|cer|keystore|jks)$/i.test(name)) return false;
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function rootOf(connector: Connector | undefined): string {
  const rootPath = connector?.config.rootPath;
  if (rootPath === undefined || rootPath.trim() === '') {
    throw new Error('This folder connector has no folder configured.');
  }
  if (!isAbsolute(rootPath)) {
    throw new Error('The connector folder must be an absolute path.');
  }
  return rootPath;
}

async function readText(path: string, maxBytes: number): Promise<string | undefined> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const bytes = buffer.subarray(0, bytesRead);
    // NUL bytes indicate binary content.
    if (bytes.includes(0)) return undefined;
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

export class FilesConnectorLifecycle implements ConnectorLifecycle {
  readonly kind = 'files' as const;
  private readonly maxFileBytes: number;
  private readonly maxItemsPerSync: number;
  private readonly maxEntriesScanned: number;

  constructor(options: FilesConnectorOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 256 * 1024;
    this.maxItemsPerSync = options.maxItemsPerSync ?? 50;
    this.maxEntriesScanned = options.maxEntriesScanned ?? 50_000;
  }

  /** Verifies the folder exists, is a directory and is readable. */
  async authorize(connector?: Connector): Promise<void> {
    const root = rootOf(connector);
    let info;
    try {
      info = await stat(root);
    } catch {
      throw new Error(`Folder not found: ${root}`);
    }
    if (!info.isDirectory()) throw new Error(`Not a folder: ${root}`);
    try {
      await access(root, constants.R_OK | constants.X_OK);
    } catch {
      throw new Error(`Conductor cannot read ${root}. Check folder permissions.`);
    }
  }

  async retrieve(cursor: string | undefined, connector?: Connector): Promise<RetrieveResult> {
    const root = await realpath(rootOf(connector));
    const since = parseFilesCursor(cursor)?.mtimeMs ?? -1;
    const candidates = await this.scan(root, since);

    // Oldest first so the cursor can advance monotonically across batches.
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.relativePath.localeCompare(b.relativePath));
    let batch = candidates.slice(0, this.maxItemsPerSync);
    const last = batch.at(-1);
    if (last !== undefined && batch.length < candidates.length) {
      // Never split files sharing the boundary mtime across batches, or the
      // strict `>` cursor comparison would skip the remainder.
      batch = candidates.filter((c) => c.mtimeMs <= last.mtimeMs);
    }

    const items: RetrievedItem[] = [];
    let maxMtime = since;
    for (const candidate of batch) {
      maxMtime = Math.max(maxMtime, candidate.mtimeMs);
      let content: string | undefined;
      try {
        content = await readText(candidate.absolute, this.maxFileBytes);
      } catch {
        continue; // unreadable (permissions, removed mid-scan): skip
      }
      if (content === undefined || content.trim() === '') continue;
      items.push({
        externalId: candidate.relativePath,
        content,
        sourceTimestamp: new Date(candidate.mtimeMs).toISOString(),
        permissions: [`filesystem_read:${root}`],
        origin: candidate.relativePath,
      });
    }

    const next: FilesCursor = { v: 1, mtimeMs: maxMtime };
    return { items, ...(maxMtime >= 0 ? { nextCursor: JSON.stringify(next) } : {}) };
  }

  async revoke(): Promise<void> {
    // Nothing is held open between syncs; the runtime stops its watcher.
  }

  private async scan(root: string, since: number): Promise<Candidate[]> {
    const found: Candidate[] = [];
    const queue: string[] = [root];
    let visited = 0;
    while (queue.length > 0 && visited < this.maxEntriesScanned) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > this.maxEntriesScanned) break;
        const absolute = join(dir, entry.name);
        // Dirent reports symlinks as such; they are never followed.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!isIgnoredDirectory(entry.name)) queue.push(absolute);
          continue;
        }
        if (!entry.isFile() || !isIndexableFile(entry.name)) continue;
        let info;
        try {
          info = await lstat(absolute);
        } catch {
          continue;
        }
        if (!info.isFile() || info.size === 0 || info.size > this.maxFileBytes) continue;
        if (info.mtimeMs <= since) continue;
        found.push({
          absolute,
          relativePath: relative(root, absolute).split(sep).join('/'),
          mtimeMs: info.mtimeMs,
          size: info.size,
        });
      }
    }
    return found;
  }
}
