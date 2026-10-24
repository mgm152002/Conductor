import { useCallback, useEffect } from 'react';
import type { CatalogEntryView, InstallOutcome } from '@shared/catalog';
import { useCliCatalogStore } from '../stores';

// Wires the Connected apps UI to the `window.conductor.cliCatalog` bridge. On
// mount it loads the last-scanned views via `list()` then triggers a fresh
// `rescan()` so the store reflects the current PATH (Requirement 6.1, 6.2). It
// exposes `rescan`, `installCommand`, and an `install` that round-trips the
// confirmation flow through the main process, returning the typed
// `InstallOutcome` so the caller can drive the two-step confirm: a
// `confirmation_required` result changed nothing, so the card shows the exact
// command and re-issues `install` with `confirmed: true`. When an install's
// outcome indicates the catalog changed (`installed` or
// `install_succeeded_not_found`), the entries are refreshed.

interface UseCliCatalogResult {
  entries: CatalogEntryView[];
  loading: boolean;
  error: string | null;
  rescan: () => Promise<void>;
  installCommand: (entryId: string) => Promise<string>;
  install: (input: {
    entryId: string;
    confirmed: boolean;
  }) => Promise<InstallOutcome>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export function useCliCatalog(): UseCliCatalogResult {
  const entries = useCliCatalogStore((s) => s.entries);
  const loading = useCliCatalogStore((s) => s.loading);
  const error = useCliCatalogStore((s) => s.error);
  const setEntries = useCliCatalogStore((s) => s.setEntries);
  const setLoading = useCliCatalogStore((s) => s.setLoading);
  const setError = useCliCatalogStore((s) => s.setError);

  const rescan = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.conductor.cliCatalog.rescan();
      setEntries(next);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [setEntries, setLoading, setError]);

  const installCommand = useCallback(
    async (entryId: string): Promise<string> => {
      setError(null);
      try {
        return await window.conductor.cliCatalog.installCommand(entryId);
      } catch (err) {
        setError(messageOf(err));
        throw err;
      }
    },
    [setError],
  );

  const install = useCallback(
    async (input: {
      entryId: string;
      confirmed: boolean;
    }): Promise<InstallOutcome> => {
      setError(null);
      try {
        const outcome = await window.conductor.cliCatalog.install(input);
        // A completed install may have changed the catalog (a binary now on
        // PATH, a newly-registered adapter); refresh so the UI reflects it. A
        // confirmation_required/unconfigured/failed result changed nothing, so
        // leave the current entries.
        if (
          outcome.status === 'installed' ||
          outcome.status === 'install_succeeded_not_found'
        ) {
          await rescan();
        }
        return outcome;
      } catch (err) {
        setError(messageOf(err));
        throw err;
      }
    },
    [rescan, setError],
  );

  useEffect(() => {
    void (async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        // Seed the store with the last-scanned views, then re-derive against
        // the current PATH so a CLI installed since the last scan shows up.
        const seeded = await window.conductor.cliCatalog.list();
        setEntries(seeded);
        const next = await window.conductor.cliCatalog.rescan();
        setEntries(next);
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [setEntries, setLoading, setError]);

  return { entries, loading, error, rescan, installCommand, install };
}
