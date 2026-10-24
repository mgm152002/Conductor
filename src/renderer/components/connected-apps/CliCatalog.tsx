import { useCliCatalog } from '../../hooks/useCliCatalog';
import { CatalogEntryCard } from './CatalogEntryCard';

// The Connected apps catalog surface (Requirement 4.1, 4.5). On mount the
// `useCliCatalog` hook loads the last-scanned views then re-derives every entry
// against the current PATH; this surface lists each supported agent CLI with
// its display name and current status and offers the two-step install confirm
// per entry via `CatalogEntryCard`.
//
// A top-level error from the hook (a failed list/rescan round-trip) is surfaced
// here; per-entry install errors are surfaced on the card itself. While the
// first scan is in flight and nothing has been loaded yet the surface shows a
// loading indicator.

export function CliCatalog(): React.JSX.Element {
  const { entries, loading, error, installCommand, install, rescan } = useCliCatalog();

  return (
    <section className="flex flex-col gap-4" aria-label="Agent CLI catalog">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-foreground">
          Agent CLIs
        </h2>
        <p className="text-xs text-muted-foreground">
          Supported agent command-line tools. Install an available CLI after
          reviewing the exact command, or see which are already on your PATH.
        </p>
      </div>

      {error !== null ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}

      {loading && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Scanning for installed agent CLIs…
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agent CLIs are available yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <li key={entry.id}>
              <CatalogEntryCard
                entry={entry}
                installCommand={installCommand}
                install={install}
                rescan={rescan}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
