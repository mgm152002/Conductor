import { useState } from 'react';
import type {
  CatalogEntryView,
  CatalogStatus,
  InstallOutcome,
} from '@shared/catalog';

// One supported agent CLI on the Connected apps screen. Mirrors
// `ResumeItemCard`'s `pending`-confirmation state machine (Requirement 5.1,
// 5.2): an `available` entry's first "Install" click asks the main process for
// the exact command (install({ confirmed: false }) → `confirmation_required`
// carrying the command), which flips the card into an inline confirm step. Only
// an explicit "Confirm install" click re-issues install({ confirmed: true }) so
// nothing runs on PATH without the user seeing and approving the exact command.
//
// `installed` presents an installed badge plus the discovered binary and no
// install action; a registration failure on an installed entry is surfaced
// (Requirement 3.4). `unconfigured` presents a "not yet available" badge and no
// install action (Requirement 4.4). While an install runs the card shows a
// busy indicator (Requirement 6.4) and a `failed` outcome surfaces its error
// output (Requirement 6.5).

interface CatalogEntryCardProps {
  entry: CatalogEntryView;
  installCommand: (entryId: string) => Promise<string>;
  install: (input: {
    entryId: string;
    confirmed: boolean;
  }) => Promise<InstallOutcome>;
  /** Re-scan PATH (after a manual install). */
  rescan?: () => Promise<void>;
}

const STATUS_LABEL: Record<CatalogStatus, string> = {
  installed: 'Installed',
  available: 'Available',
  unconfigured: 'Not yet available',
};

const STATUS_STYLE: Record<CatalogStatus, string> = {
  installed: 'text-success ',
  available: 'text-warning ',
  unconfigured: 'text-muted-foreground ',
};

export function CatalogEntryCard({
  entry,
  installCommand,
  install,
  rescan,
}: CatalogEntryCardProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  // Holds the exact command to confirm. Non-null flips the card into the
  // inline confirm step, exactly like ResumeItemCard's `pending`.
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // First "Install" click: fetch the exact command and show the confirm step.
  // Nothing runs on PATH here — the command is obtained from the main process
  // (either installCommand, or an install that refuses pending confirmation).
  async function requestInstall(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const outcome = await install({ entryId: entry.id, confirmed: false });
      if (outcome.status === 'confirmation_required') {
        setPending(outcome.command);
        return;
      }
      if (outcome.status === 'unconfigured') {
        setError('This CLI is not yet available to install.');
        return;
      }
      // Any other outcome without confirmation is unexpected for an available
      // entry; fall back to fetching the command string directly so the user
      // still sees exactly what would run before confirming.
      const command = await installCommand(entry.id);
      setPending(command);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the install command.');
    } finally {
      setBusy(false);
    }
  }

  // Explicit "Confirm install" click: re-issue with confirmed: true. Only this
  // path lets a command actually run (Requirement 5.2).
  async function confirmInstall(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const outcome = await install({ entryId: entry.id, confirmed: true });
      switch (outcome.status) {
        case 'installed':
          setPending(null);
          setMessage('Installed.');
          break;
        case 'install_succeeded_not_found':
          setPending(null);
          setMessage(
            'Install completed, but the binary was not found on PATH yet.',
          );
          break;
        case 'failed':
          // Keep the confirm step open so the user can retry; surface the
          // exit code and error output (Requirement 6.3, 6.5).
          setError(
            `Install failed (exit ${String(outcome.exitCode)}).${
              outcome.errorOutput.length > 0 ? `\n${outcome.errorOutput}` : ''
            }`,
          );
          break;
        case 'unconfigured':
          setPending(null);
          setError('This CLI is not yet available to install.');
          break;
        case 'confirmation_required':
          // Confirmation was sent but still required: show the latest command.
          setPending(outcome.command);
          break;
        default:
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The install failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            {entry.displayName}
          </span>
          {entry.status === 'installed' &&
          entry.discoveredBinary !== undefined ? (
            <span className="truncate text-xs text-muted-foreground">
              Binary: {entry.discoveredBinary}
            </span>
          ) : null}
        </div>
        <span
          className={`shrink-0 text-xs font-semibold ${STATUS_STYLE[entry.status]}`}
        >
          {STATUS_LABEL[entry.status]}
        </span>
      </div>

      {entry.status === 'available' && entry.installRunnable === false ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3">
          <p className="text-xs text-foreground">This vendor only publishes a shell installer, which Conductor doesn’t run for you. Run it in Terminal, then rescan:</p>
          <code className="block overflow-x-auto rounded-md bg-code px-2 py-1.5 font-mono text-xs text-foreground">{entry.installCommand}</code>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { void navigator.clipboard.writeText(entry.installCommand ?? '').then(() => { setMessage('Command copied.'); }); }} className="rounded-md border border-input px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent">Copy command</button>
            <button type="button" onClick={() => { void (rescan ?? (async () => { await window.conductor.cliCatalog.rescan(); }))().then(() => { setMessage('Rescanned. If it still shows as not installed, open a new Terminal window and check that the command runs.'); }); }} className="rounded-md border border-input px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent">I’ve installed it — rescan</button>
          </div>
          {entry.docsUrl !== undefined ? <p className="text-2xs text-muted-foreground">Instructions: {entry.docsUrl}</p> : null}
        </div>
      ) : entry.status === 'available' ? (
        pending !== null ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/6 p-3"
            role="alertdialog"
            aria-label={`Confirm install of ${entry.displayName}`}
          >
            <p className="text-xs text-foreground">
              This will run the following command:
            </p>
            <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs text-foreground">
              {pending}
            </code>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void confirmInstall();
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Installing…' : 'Confirm install'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setError(null);
                }}
                className="rounded-md border border-input px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void requestInstall();
              }}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Loading…' : 'Install'}
            </button>
          </div>
        )
      ) : null}

      {entry.setupNote !== undefined && entry.status !== 'unconfigured' ? (
        <p className="text-2xs text-muted-foreground">{entry.setupNote}</p>
      ) : null}
      {entry.status === 'installed' && entry.canRunTasks === true && entry.registrationError === undefined ? (
        <p className="text-2xs text-success">Conductor can route tasks to {entry.displayName}.</p>
      ) : null}

      {entry.status === 'installed' &&
      entry.registrationError !== undefined ? (
        <p className="whitespace-pre-wrap text-xs text-destructive-foreground">
          Registration failed: {entry.registrationError}
        </p>
      ) : null}

      {error !== null ? (
        <p className="whitespace-pre-wrap text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}

      {message !== null ? (
        <p className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
