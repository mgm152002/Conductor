import { useCliCatalog } from '../../hooks/useCliCatalog';
import { CatalogEntryCard } from './CatalogEntryCard';
import { SettingsSection } from '../settings/SettingsLayout';

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
    <SettingsSection title="Agent CLIs" className="[&>div:first-child]:px-3" >
      <section className="flex flex-col gap-2" aria-label="Agent CLI catalog">

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
        <ul className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5 *:not-first:border-t *:not-first:border-border/50">
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
    </SettingsSection>
  );
}
