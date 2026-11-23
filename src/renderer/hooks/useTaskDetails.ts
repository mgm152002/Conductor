import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { useTaskStore } from '../stores/task-store';

// One shared loader for task details. A thread view asks for the same task's
// details from several places at once (the turn, the thread, the details card,
// agent activity); without sharing, each streamed chunk cost one full IPC
// round-trip per caller. Callers asking for the same task at the same version
// now share one request, and the last result is kept so reopening a thread
// paints at once while a fresh copy loads behind it.

interface Entry {
  /** Which version of the task this request is for; '' means "refetch next time". */
  key: string;
  promise: Promise<TaskDetails>;
  /** The newest details loaded for this task, from this or an earlier request. */
  value: TaskDetails | undefined;
}

const MAX_CACHED = 64;
const cache = new Map<string, Entry>();

function remember(id: string, entry: Entry): void {
  cache.delete(id);
  cache.set(id, entry);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** The details last loaded for a task, if any. */
export function cachedTaskDetails(id: string): TaskDetails | undefined {
  return cache.get(id)?.value;
}

export function loadTaskDetails(id: string, key: string, force: boolean): Promise<TaskDetails> {
  const hit = cache.get(id);
  if (!force && hit !== undefined && hit.key === key) return hit.promise;
  const entry: Entry = { key, promise: window.conductor.task.details(id), value: hit?.value };
  remember(id, entry);
  entry.promise.then(
    (details) => { entry.value = details; },
    () => { if (cache.get(id) === entry) entry.key = ''; },
  );
  return entry.promise;
}

/** Test seam: forget every cached request. */
export function resetTaskDetailsCache(): void {
  cache.clear();
}

export function useTaskDetails(task: Task | null): {
  details: TaskDetails | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const id = task?.id;
  const [snapshot, setSnapshot] = useState<TaskDetails | null>(() => (id === undefined ? null : cachedTaskDetails(id) ?? null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const revision = useTaskStore((state) => task === null ? 0 : state.detailsRevision[task.id] ?? 0);
  const refresh = useCallback(() => { setRefreshVersion((value) => value + 1); }, []);
  const updatedAt = task?.updatedAt;
  const state = task?.state;
  const lastRefresh = useRef(refreshVersion);
  const shown = useRef(snapshot);
  shown.current = snapshot;

  useEffect(() => {
    let active = true;
    if (id === undefined) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }
    const force = lastRefresh.current !== refreshVersion;
    lastRefresh.current = refreshVersion;
    // Only show "loading" when there is nothing to show yet; refreshing a
    // reply that is already on screen should not re-render it twice.
    if (shown.current?.task.id !== id && cachedTaskDetails(id) === undefined) setLoading(true);
    void loadTaskDetails(id, `${updatedAt ?? ''}|${state ?? ''}|${revision}`, force).then((details) => {
      if (!active) return;
      setSnapshot(details);
      setError(null);
      useTaskStore.getState().setTasks([details.task]);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Could not load task details');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, updatedAt, state, revision, refreshVersion]);

  const details = snapshot?.task.id === id ? snapshot : (id === undefined ? null : cachedTaskDetails(id) ?? null);
  return { details, loading, error, refresh };
}
