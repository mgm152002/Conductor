import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageRange, UsageSummary } from '@shared/usage';

// Loads the usage overview for the selected range from the preload bridge.
// Exposes `loading`, `error`, and a `refresh` callback so the Usage screen can
// show a status while the first request is in flight, keep the previous data
// visible during a manual refresh, and retry a failed request without losing
// the selected range (Requirement 2.1, 3.3).

interface UsageData {
  range: UsageRange;
  summary: UsageSummary;
}

export interface UseUsageOverviewResult {
  summary: UsageSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Could not load usage';
}

/** How often an open Usage screen re-probes CLI limits (matches the poller). */
export const USAGE_LIMITS_REFRESH_MS = 5 * 60_000;

export function useUsageOverview(range: UsageRange): UseUsageOverviewResult {
  const [data, setData] = useState<UsageData | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Range changes read the snapshots the background poller stored; only an
  // explicit refresh (button, first-load probe, or the auto-refresh timer)
  // opts into the slower CLI quota probes.
  const refreshLimits = useRef(false);
  const probedOnce = useRef(false);

  useEffect(() => {
    let active = true;
    const probe = refreshLimits.current;
    setPending(true);
    setError(null);
    window.conductor.usage.summary({ range, ...(probe ? { refreshLimits: true } : {}) })
      .then((summary) => {
        if (active) setData({ range, summary });
      })
      .catch((err: unknown) => {
        if (active) setError(messageOf(err));
      })
      .finally(() => {
        // Cleared after the request settles so React StrictMode's duplicate
        // development effect still sends the probe on both invocations.
        if (probe) refreshLimits.current = false;
        if (active) setPending(false);
      });
    return () => { active = false; };
  }, [range, revision]);

  const refresh = useCallback((): void => {
    refreshLimits.current = true;
    setRevision((value) => value + 1);
  }, []);

  // Fetch limits when the screen opens: show stored snapshots first (fast),
  // then probe the CLIs once so the windows are current rather than whatever
  // the last task or poll happened to record. Re-probe while the screen
  // stays open, on the background poller's cadence.
  useEffect(() => {
    if (data !== null && !probedOnce.current) {
      probedOnce.current = true;
      refresh();
    }
  }, [data, refresh]);

  useEffect(() => {
    const timer = window.setInterval(refresh, USAGE_LIMITS_REFRESH_MS);
    return () => { window.clearInterval(timer); };
  }, [refresh]);

  // Never expose data loaded for a different range. Until the new request
  // resolves the screen stays in its loading state rather than showing stale
  // numbers under the new range's chips.
  const summary = data?.range === range ? data.summary : null;
  const loading = error === null && (pending || data?.range !== range);

  return { summary, loading, error, refresh };
}
