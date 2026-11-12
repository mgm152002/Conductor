import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ThreadTierPref, ThreadTierPrefs } from '../../renderer/lib/thread-tiers';

// Which threads the user settled or snoozed. It used to live only in the
// desktop window; it lives here now so the phone and the desktop show the same
// thing. A small JSON file in the app's data folder.

const clean = (raw: unknown): ThreadTierPrefs => {
  const out: ThreadTierPrefs = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, Partial<ThreadTierPref>>)) {
    if (!/^[\w-]{1,64}$/.test(key) || value === null || typeof value !== 'object') continue;
    if ((value.mode === 'settled' || value.mode === 'snoozed') && typeof value.seenUpdatedAt === 'string') {
      out[key] = { mode: value.mode, seenUpdatedAt: value.seenUpdatedAt, ...(typeof value.snoozedUntil === 'string' ? { snoozedUntil: value.snoozedUntil } : {}) };
    }
  }
  return out;
};

export class ThreadTierStore {
  private prefs: ThreadTierPrefs = {};

  constructor(private readonly file: string) {
    try { if (existsSync(file)) this.prefs = clean(JSON.parse(readFileSync(file, 'utf8')) as unknown); } catch { this.prefs = {}; }
  }

  get(): ThreadTierPrefs { return { ...this.prefs }; }

  /** Set one thread's disposition, or clear it with undefined. */
  put(key: string, pref: ThreadTierPref | undefined): ThreadTierPrefs {
    const next = { ...this.prefs };
    if (pref === undefined) delete next[key]; else Object.assign(next, clean({ [key]: pref }));
    return this.save(next);
  }

  /** Merge prefs from the desktop's old local copy (only keys not set here). */
  adopt(local: unknown): ThreadTierPrefs {
    const incoming = clean(local);
    return this.save({ ...incoming, ...this.prefs });
  }

  private save(next: ThreadTierPrefs): ThreadTierPrefs {
    this.prefs = next;
    try { const tmp = `${this.file}.tmp`; writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 }); renameSync(tmp, this.file); } catch { /* kept in memory */ }
    return this.get();
  }
}
