import { posix } from 'node:path';

// Locks on the folder every agent's sandbox shares.
//
// Each agent has its own container, so nothing inside one sandbox can see
// what another is doing. Every sandbox tool call passes through Conductor's
// gateway, though, so the lock table lives here, in the app: one table for
// all agents. A lock covers a file or a whole folder (and everything under
// it), is exclusive, and belongs to one run of one agent. It is dropped when
// the agent unlocks it or when that run ends, so a crashed or stopped run
// never leaves the folder blocked. Reading is never blocked.

export interface LockOwner {
  /** The run holding the lock (a task id). */
  id: string;
  /** Who to name when someone else is turned away, e.g. "Researcher". */
  name: string;
}

export interface SharedLock { path: string; owner: LockOwner; since: string }

export type LockResult = { ok: true; path: string } | { ok: false; reason: string; holder?: SharedLock };

/** Characters that end a path inside a shell command or code string. */
const PATH_END = String.raw`\s'"\`;|&<>()$*?\\,\[\]{}=`;

export class SharedLocks {
  private readonly locks = new Map<string, SharedLock>();
  private readonly mention: RegExp;

  constructor(private readonly root: string) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const home = root.slice(0, root.lastIndexOf('/')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leaf = root.slice(root.lastIndexOf('/') + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The folder by its full path, or as ~/shared and $HOME/shared.
    this.mention = new RegExp(`(?:${escaped}|(?:~|\\$HOME|\\$\\{HOME\\}|${home})/${leaf})(?![^/${PATH_END}])(?:/[^${PATH_END}]*)?`, 'g');
  }

  /** The path inside the shared folder, normalised; undefined when it is elsewhere. */
  resolve(path: string): string | undefined {
    const home = this.root.slice(0, this.root.lastIndexOf('/'));
    const expanded = path.trim().replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
    if (!expanded.startsWith('/')) return undefined;
    const clean = posix.normalize(expanded).replace(/\/+$/, '');
    return clean === this.root || clean.startsWith(`${this.root}/`) ? clean : undefined;
  }

  /** Every shared-folder path named anywhere in a tool call's arguments. */
  mentioned(value: unknown): string[] {
    const found = new Set<string>();
    const walk = (item: unknown): void => {
      if (typeof item === 'string') {
        for (const match of item.matchAll(this.mention)) {
          const path = this.resolve(match[0]);
          if (path !== undefined) found.add(path);
        }
      } else if (Array.isArray(item)) item.forEach(walk);
      else if (item !== null && typeof item === 'object') Object.values(item).forEach(walk);
    };
    walk(value);
    return [...found];
  }

  /** Another run's lock that covers this path, or sits underneath it. */
  blocker(path: string, ownerId: string): SharedLock | undefined {
    for (const lock of this.locks.values()) {
      if (lock.owner.id === ownerId) continue;
      if (lock.path === path || path.startsWith(`${lock.path}/`) || lock.path.startsWith(`${path}/`)) return lock;
    }
    return undefined;
  }

  /** Take the lock on a file or folder inside the shared folder. Taking it again is fine. */
  acquire(path: string, owner: LockOwner): LockResult {
    const clean = this.resolve(path);
    if (clean === undefined) return { ok: false, reason: `Only paths inside ${this.root} can be locked.` };
    if (clean === this.root) return { ok: false, reason: `Lock a file or a subfolder, not all of ${this.root}.` };
    const holder = this.blocker(clean, owner.id);
    if (holder !== undefined) return { ok: false, reason: refusal(holder), holder };
    if (!this.covered(clean, owner.id)) this.locks.set(clean, { path: clean, owner, since: new Date().toISOString() });
    return { ok: true, path: clean };
  }

  /** Whether this run already holds the path, directly or through a folder lock. */
  private covered(path: string, ownerId: string): boolean {
    for (const lock of this.locks.values()) {
      if (lock.owner.id === ownerId && (lock.path === path || path.startsWith(`${lock.path}/`))) return true;
    }
    return false;
  }

  /** Give up a lock this run holds. False when it holds no lock on exactly that path. */
  release(path: string, ownerId: string): boolean {
    const clean = this.resolve(path);
    if (clean === undefined || this.locks.get(clean)?.owner.id !== ownerId) return false;
    this.locks.delete(clean);
    return true;
  }

  /** The run ended: drop everything it held. */
  releaseAll(ownerId: string): void {
    for (const [path, lock] of this.locks) if (lock.owner.id === ownerId) this.locks.delete(path);
  }

  list(): SharedLock[] {
    return [...this.locks.values()];
  }
}

export function refusal(lock: SharedLock): string {
  return `${lock.path} is locked by ${lock.owner.name}, who is changing it right now. Do not work around the lock. `
    + 'Do something else first and try again in a little while; the lock is released when they finish.';
}
