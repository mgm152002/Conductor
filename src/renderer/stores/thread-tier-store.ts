import { create } from 'zustand';
import type { ThreadTierPref, ThreadTierPrefs } from '../lib/thread-tiers';

// Per-thread tier dispositions ("settled" / "snoozed") chosen by the user in
// the sidebar or thread header. This is presentation state the user owns, so
// it persists in localStorage like the composer selection — the durable task
// lifecycle stays with the orchestrator and is never rewritten by a tier
// change. A disposition records the thread's `latest.updatedAt` at the time
// it was made so new activity can supersede a stale "settled".

const STORAGE_KEY = 'conductor.thread-tiers';

interface ThreadTierState {
  prefs: ThreadTierPrefs;
  /** Mark a thread settled as of its current `latest.updatedAt`. */
  markSettled: (threadKey: string, seenUpdatedAt: string) => void;
  /** Defer a thread until `until` (ISO-8601); omit for an indefinite snooze. */
  snooze: (threadKey: string, seenUpdatedAt: string, until?: string) => void;
  /**
   * Drop any disposition: a snoozed thread wakes into its natural tier, a
   * settled thread returns to Needs attention / Working as its state dictates.
   */
  clear: (threadKey: string) => void;
  reset: () => void;
}

function loadPrefs(): ThreadTierPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<ThreadTierPref>>;
    const prefs: ThreadTierPrefs = {};
    for (const [key, pref] of Object.entries(parsed)) {
      if ((pref.mode === 'settled' || pref.mode === 'snoozed') && typeof pref.seenUpdatedAt === 'string') {
        prefs[key] = {
          mode: pref.mode,
          seenUpdatedAt: pref.seenUpdatedAt,
          ...(typeof pref.snoozedUntil === 'string' ? { snoozedUntil: pref.snoozedUntil } : {}),
        };
      }
    }
    return prefs;
  } catch {
    return {};
  }
}

/** The authoritative copy lives in the app (the phone edits it too). */
function push(key: string, pref: ThreadTierPref | null): void {
  if (typeof window === 'undefined') return;
  void window.conductor?.threadTiers?.put(key, pref).catch(() => undefined);
}

function savePrefs(prefs: ThreadTierPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable in restricted or privacy-mode contexts.
  }
}

export const useThreadTierStore = create<ThreadTierState>((set) => ({
  prefs: loadPrefs(),
  markSettled: (threadKey, seenUpdatedAt): void => {
    set((state) => {
      const prefs = { ...state.prefs, [threadKey]: { mode: 'settled' as const, seenUpdatedAt } };
      savePrefs(prefs);
      push(threadKey, prefs[threadKey]!);
      return { prefs };
    });
  },
  snooze: (threadKey, seenUpdatedAt, until): void => {
    set((state) => {
      const prefs = {
        ...state.prefs,
        [threadKey]: { mode: 'snoozed' as const, seenUpdatedAt, ...(until !== undefined ? { snoozedUntil: until } : {}) },
      };
      savePrefs(prefs);
      push(threadKey, prefs[threadKey]!);
      return { prefs };
    });
  },
  clear: (threadKey): void => {
    set((state) => {
      if (!(threadKey in state.prefs)) return state;
      const prefs = { ...state.prefs };
      delete prefs[threadKey];
      savePrefs(prefs);
      push(threadKey, null);
      return { prefs };
    });
  },
  reset: (): void => {
    savePrefs({});
    set({ prefs: {} });
  },
}));

// Keep this window in step with the app's copy: adopt what this window had
// before the move once, then follow changes made on the phone.
let synced = false;
function syncFromApp(): void {
  const bridge = typeof window === 'undefined' ? undefined : window.conductor?.threadTiers;
  if (bridge === undefined) return;
  const apply = (prefs: ThreadTierPrefs): void => {
    if (JSON.stringify(prefs) === JSON.stringify(useThreadTierStore.getState().prefs)) return;
    savePrefs(prefs);
    useThreadTierStore.setState({ prefs });
  };
  const pull = (): void => { void bridge.get().then((prefs) => { apply(prefs as ThreadTierPrefs); }).catch(() => undefined); };
  if (!synced) {
    synced = true;
    void bridge.adopt(useThreadTierStore.getState().prefs).then((prefs) => { apply(prefs as ThreadTierPrefs); }).catch(() => undefined);
    setInterval(pull, 4000);
  }
}
syncFromApp();
