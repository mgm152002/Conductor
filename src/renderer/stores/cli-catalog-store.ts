import { create } from 'zustand';
import type { CatalogEntryView } from '@shared/catalog';

// Renderer-side holder for the Connected apps catalog. On mount the useCliCatalog
// hook requests the last-scanned views via `window.conductor.cliCatalog.list`
// then triggers a `rescan`; both resolve to `CatalogEntryView[]` which lands
// here. The full Connected apps screen/card land in tasks 7.3/7.4; this store
// establishes the state contract now, mirroring the Resume Center store.

interface CliCatalogState {
  entries: CatalogEntryView[];
  loading: boolean;
  error: string | null;
  setEntries: (entries: CatalogEntryView[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useCliCatalogStore = create<CliCatalogState>((set) => ({
  entries: [],
  loading: false,
  error: null,
  setEntries: (entries): void => {
    set({ entries });
  },
  setLoading: (loading): void => {
    set({ loading });
  },
  setError: (error): void => {
    set({ error });
  },
}));
