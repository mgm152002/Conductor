// The CliCatalog façade: the single entry point the IPC handlers call. It owns
// the fixed `CATALOG_ENTRIES` and composes the four seams that do the actual
// work — the discovery service (PATH probe), status derivation (`deriveStatus`),
// the registrar (Registry sync), and the install service (confirmation-gated
// install). None of those are reachable from IPC directly; the catalog is the
// only façade.
//
// It keeps an internal cache of the last-scanned `CatalogEntryView[]` so `list()`
// can return the last known state WITHOUT re-probing PATH on every call — callers
// trigger a `rescan()` explicitly (Requirement 2.5). `rescan()` re-derives every
// entry against PATH, reconciles the Registry (register newly-installed via
// `registrar.ensureRegistered`, deregister disappeared via
// `registrar.ensureDeregistered`), keeps `installed` status on a registration
// failure and carries the error into the view (Requirement 3.4), and populates
// `installCommand` on `available` entries and `discoveredBinary` on `installed`.
//
// `install({ entryId, confirmed })` delegates to the `InstallService` gate. On a
// zero-exit success (`install_succeeded_not_found`) it triggers a `rescan` and
// maps the outcome to `{ status: 'installed' }` when the binary is then found on
// PATH, or keeps `install_succeeded_not_found` when it is still absent
// (Requirement 6.1, 6.2). Unknown entry ids in `installCommand`/`install` throw,
// which the router maps to a typed `handler_error`.

import { RUNNABLE_AGENT_IDS } from '../adapters/objective-cli-adapter';
import type {
  CatalogEntry,
  CatalogEntryView,
  InstallOutcome,
} from '@shared/catalog';

import { CATALOG_ENTRIES } from './catalog-entries';
import {
  DefaultCliDiscoveryService,
  type CliDiscoveryService,
} from './discovery-service';
import { deriveStatus } from './status';
import { CliRegistrar } from './registrar';
import { InstallService } from './install-service';

/** Raised when an entry id is requested that is not in `CATALOG_ENTRIES`. */
export class UnknownCatalogEntryError extends Error {
  constructor(readonly entryId: string) {
    super(`Catalog entry "${entryId}" is not a known supported CLI`);
    this.name = 'UnknownCatalogEntryError';
  }
}

/** Injectable seams for the façade, so it is testable with fakes. */
export interface CliCatalogDeps {
  /** PATH discovery seam; defaults to the real `DefaultCliDiscoveryService`. */
  discovery: CliDiscoveryService;
  /** Registry sync seam; defaults to a `CliRegistrar` over the real Registry. */
  registrar: CliRegistrar;
  /** Confirmation-gated install seam; defaults to a real `InstallService`. */
  installService: InstallService;
}

/**
 * The catalog façade. Composes the discovery service, status derivation, the
 * registrar, and the install service over the fixed `CATALOG_ENTRIES`. Caches
 * the last-scanned views for `list()`; `rescan()` refreshes them.
 */
export class CliCatalog {
  private readonly entries: readonly CatalogEntry[];
  private readonly discovery: CliDiscoveryService;
  private readonly registrar: CliRegistrar;
  private readonly installService: InstallService;

  /** Last-scanned views, keyed by entry id, so `list()` never re-probes PATH. */
  private lastScanned: Map<string, CatalogEntryView>;

  /**
   * @param deps Injectable seams. All default to the real implementations, so
   *   `new CliCatalog({ registrar })` is enough to wire the catalog with the
   *   app's `Registry` while leaving discovery and install at their defaults.
   * @param entries The catalog entries; defaults to the fixed `CATALOG_ENTRIES`.
   */
  constructor(
    deps: Partial<CliCatalogDeps> & Pick<CliCatalogDeps, 'registrar'>,
    entries: readonly CatalogEntry[] = CATALOG_ENTRIES,
  ) {
    this.entries = entries;
    this.registrar = deps.registrar;
    this.discovery = deps.discovery ?? new DefaultCliDiscoveryService();
    this.installService = deps.installService ?? new InstallService();

    // Seed the cache from the static entries so `list()` has a defined result
    // before the first `rescan()`. Statuses here are derived without probing
    // PATH (no discovered binary), which yields `unconfigured`/`available`
    // honestly for placeholder entries and a conservative pre-scan view
    // otherwise; the first `rescan()` replaces it with the real PATH-derived
    // state.
    this.lastScanned = new Map(
      this.entries.map((entry) => [entry.id, this.viewWithoutDiscovery(entry)]),
    );
  }

  /**
   * Every entry with its last-scanned status. Does NOT re-probe PATH — returns
   * the cached views from the most recent `rescan()` (or the seeded pre-scan
   * views if `rescan()` has not run yet). Callers trigger `rescan()` explicitly
   * (Requirement 2.5).
   */
  list(): CatalogEntryView[] {
    return this.entries.map((entry) => {
      const view = this.lastScanned.get(entry.id);
      // Defensive: the cache is keyed by every entry id at construction, so a
      // miss cannot happen, but fall back to a pre-scan view rather than throw.
      return view ?? this.viewWithoutDiscovery(entry);
    });
  }

  /**
   * Re-evaluate every entry against PATH, update the cached views, and
   * reconcile the Registry: register a newly-`installed` entry via the
   * registrar, deregister one that disappeared from PATH. Returns the updated
   * views. (Requirement 2.5, 3.1, 3.3.)
   */
  rescan(): CatalogEntryView[] {
    const views = this.entries.map((entry) => this.scanEntry(entry));
    this.lastScanned = new Map(views.map((view) => [view.id, view]));
    return views;
  }

  /**
   * The exact command string an install would run for an entry, for display.
   *
   * @throws UnknownCatalogEntryError when the id is not in `CATALOG_ENTRIES`
   *   (router → `handler_error`).
   * @throws EntryUnconfiguredError when the entry is `unconfigured` (via the
   *   install service).
   */
  installCommand(entryId: string): string {
    const entry = this.requireEntry(entryId);
    return this.installService.command(entry);
  }

  /**
   * Install an entry behind the confirmation gate. Delegates to the
   * `InstallService`; on a zero-exit success (`install_succeeded_not_found`) it
   * triggers a `rescan()` and maps the outcome to `{ status: 'installed' }`
   * when the binary is then discovered on PATH (and its adapter registered),
   * keeping `install_succeeded_not_found` when it is still absent
   * (Requirement 6.1, 6.2). A `failed` or `confirmation_required` or
   * `unconfigured` outcome is returned unchanged.
   *
   * @throws UnknownCatalogEntryError when the id is not in `CATALOG_ENTRIES`
   *   (router → `handler_error`).
   */
  async install(input: {
    entryId: string;
    confirmed: boolean;
  }): Promise<InstallOutcome> {
    const entry = this.requireEntry(input.entryId);
    const outcome = await this.installService.install(entry, input.confirmed);

    // The install command ran and exited zero. Re-scan so the Registry and the
    // cached views reflect the freshly-installed binary, then promote the
    // outcome to `installed` when the re-scan found it on PATH.
    if (outcome.status === 'install_succeeded_not_found') {
      this.rescan();
      const view = this.lastScanned.get(entry.id);
      if (view?.status === 'installed') {
        return { status: 'installed', entryId: entry.id };
      }
    }

    return outcome;
  }

  /** Look up an entry by id, throwing for an unknown id. */
  private requireEntry(entryId: string): CatalogEntry {
    const entry = this.entries.find((e) => e.id === entryId);
    if (entry === undefined) {
      throw new UnknownCatalogEntryError(entryId);
    }
    return entry;
  }

  /**
   * Scan a single entry against PATH: discover, derive its status, reconcile
   * the Registry, and build the view. This is the per-entry body of `rescan()`.
   */
  private scanEntry(entry: CatalogEntry): CatalogEntryView {
    const discoveredBinary = this.discovery.discover(entry.candidateBinaryNames);
    const status = deriveStatus(entry, discoveredBinary);

    if (status === 'installed' && discoveredBinary !== undefined) {
      return this.reconcileInstalled(entry, discoveredBinary);
    }

    // Not installed: the entry's adapter must not linger in the Registry. If it
    // was previously installed and registered, deregister it (Requirement 3.3);
    // `ensureDeregistered` is a no-op when nothing is registered under the id.
    this.registrar.ensureDeregistered(entry.id);

    if (status === 'available') {
      // Populate the exact install command on an `available` view so the UI can
      // show it. `command` throws only for unconfigured entries, which never
      // derive to `available`, so this is safe.
      return {
        ...this.base(entry),
        status,
        installCommand: this.installService.command(entry),
        installRunnable: entry.installMethod.kind !== 'manual',
        ...(entry.installMethod.kind === 'manual' ? { docsUrl: entry.installMethod.docsUrl } : {}),
      };
    }

    // `unconfigured`: no discovered binary and no install command.
    return { ...this.base(entry), status };
  }

  /**
   * Reconcile an `installed` entry into the Registry and build its view. The
   * entry stays `installed` regardless of registration outcome (the binary is
   * genuinely on PATH); a registration failure is carried into the view so the
   * UI can surface it (Requirement 3.4).
   */
  private reconcileInstalled(
    entry: CatalogEntry,
    discoveredBinary: string,
  ): CatalogEntryView {
    const result = this.registrar.ensureRegistered(entry, discoveredBinary);

    if (result.kind === 'failed') {
      // Keep `installed` — the binary is on PATH — and surface the failure.
      return {
        ...this.base(entry),
        status: 'installed',
        discoveredBinary,
        registrationError: result.error,
      };
    }

    return {
      ...this.base(entry),
      status: 'installed',
      discoveredBinary,
    };
  }

  /** Fields every view carries regardless of status. */
  private base(entry: CatalogEntry): Pick<CatalogEntryView, 'id' | 'displayName' | 'canRunTasks' | 'setupNote'> {
    return {
      id: entry.id,
      displayName: entry.displayName,
      canRunTasks: RUNNABLE_AGENT_IDS.has(entry.id),
      ...(entry.setupNote !== undefined ? { setupNote: entry.setupNote } : {}),
    };
  }

  /**
   * Build a view for an entry without probing PATH — used to seed the cache
   * before the first `rescan()`. Derives status with no discovered binary, so a
   * placeholder entry is `unconfigured` and a configured-but-unscanned entry is
   * `available` (with its install command). It does NOT touch the Registry.
   */
  private viewWithoutDiscovery(entry: CatalogEntry): CatalogEntryView {
    const status = deriveStatus(entry, undefined);
    if (status === 'available') {
      return {
        ...this.base(entry),
        status,
        installCommand: this.installService.command(entry),
        installRunnable: entry.installMethod.kind !== 'manual',
        ...(entry.installMethod.kind === 'manual' ? { docsUrl: entry.installMethod.docsUrl } : {}),
      };
    }
    return { ...this.base(entry), status };
  }
}
