// Shared catalog types for the Agent CLI Catalog. These are the durable
// contracts shared across the main process (catalog model, discovery, status
// derivation, install service, registrar) and the renderer (Connected apps
// screen). They live here so both sides import the same shapes and the Zod
// request schemas in `ipc-contract.ts` can derive from them.
//
// A hard constraint shapes these types: the exact binary name(s) and the
// official install command for each supported CLI are NOT yet confirmed.
// Inventing them risks typosquatting or running the wrong tool, so an entry
// whose binary names or install method are unconfirmed is modeled as
// `unconfigured` rather than a guess, and such an entry can never produce an
// install command.

/**
 * The confirmed-or-not install method for an entry. A discriminated union so
 * the install service can exhaustively derive a command and reject
 * `unconfigured`. `unconfigured` carries no payload: it is the explicit
 * "not yet confirmed" state that never yields a command to run.
 */
export type InstallMethod =
  | { readonly kind: 'npm'; readonly package: string; readonly binName: string }
  | { readonly kind: 'brew'; readonly formula: string }
  /** A Homebrew cask (`brew install --cask <cask>`). */
  | { readonly kind: 'brew_cask'; readonly cask: string }
  /**
   * The vendor only publishes a pipe-to-shell installer. Conductor never runs
   * those; it shows the exact command for the user to run in a terminal.
   */
  | { readonly kind: 'manual'; readonly command: string; readonly docsUrl: string }
  | { readonly kind: 'script'; readonly command: string }
  | { readonly kind: 'unconfigured' };

/** The derived installation state of an entry. */
export type CatalogStatus = 'installed' | 'available' | 'unconfigured';

/**
 * A single supported agent CLI. Binary names and install method are
 * CONFIGURATION, to be confirmed per-CLI (see the requirements' Open
 * Questions). Until confirmed they stay empty / `unconfigured` and the entry
 * derives to `unconfigured`.
 */
export interface CatalogEntry {
  /** Stable identifier, also used as the Registry adapter id. */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Candidate binary names to search on PATH. EMPTY until confirmed. */
  readonly candidateBinaryNames: readonly string[];
  /** Install method. `unconfigured` until the official macOS install is confirmed. */
  readonly installMethod: InstallMethod;
  /** What the user must do after installing (sign in, etc.). */
  readonly setupNote?: string;
}

/**
 * What the IPC/list surface returns: the static entry plus its derived status
 * and, when installed, the discovered binary. Never carries a secret.
 */
export interface CatalogEntryView {
  readonly id: string;
  readonly displayName: string;
  readonly status: CatalogStatus;
  /** Present only when status === 'installed'. */
  readonly discoveredBinary?: string;
  /** Present only when status === 'available': the exact command an install would run. */
  readonly installCommand?: string;
  /** False when the install command must be run by the user in a terminal. */
  readonly installRunnable?: boolean;
  /** Vendor install docs for a manual install. */
  readonly docsUrl?: string;
  /** Whether Conductor can run tasks with this CLI once installed. */
  readonly canRunTasks?: boolean;
  /** How to finish setup (sign-in etc.) after installing. */
  readonly setupNote?: string;
  /**
   * Present when the entry is `installed` on PATH but registering its
   * `LocalCliAdapter` in the Registry failed (Requirement 3.4). The entry
   * stays `installed` (the binary genuinely exists); this field carries the
   * registration failure so the UI can surface it.
   */
  readonly registrationError?: string;
}

/**
 * Raised when an install command is requested for an entry whose install method
 * is `unconfigured` (or whose candidate binary names are empty). An
 * unconfigured entry never produces an install command — the install service
 * rejects the request rather than guessing one.
 */
export class EntryUnconfiguredError extends Error {
  constructor(readonly entryId: string) {
    super(
      `Catalog entry "${entryId}" is unconfigured: its install method is not yet confirmed`,
    );
    this.name = 'EntryUnconfiguredError';
  }
}

/**
 * The stable capability id for an entry's registered `LocalCliAdapter`, derived
 * solely from the entry id so the registrar and any later reuse agree on the
 * same string (e.g. `cli.<id>.run`).
 */
export function capabilityIdFor(entry: CatalogEntry): string {
  return `cli.${entry.id}.run`;
}

/**
 * The result of requesting an install for an entry — the shared contract across
 * the `InstallService` gate, the `CliCatalog` façade, and the validated IPC
 * surface so all three agree on the same shapes. A discriminated union on
 * `status`:
 *
 *   - `confirmation_required` — the request carried no explicit confirmation
 *     (`confirmed !== true`); the command runner was invoked ZERO times and the
 *     entry's status is unchanged. Carries the exact `command` to show so the UI
 *     can flip to its confirm step (Requirement 5.2, 5.3).
 *   - `unconfigured` — the entry's install method is not yet confirmed, so no
 *     command exists and nothing ran (Requirement 5.7).
 *   - `installed` — the command ran successfully and a subsequent re-scan found
 *     the binary, so the entry is now registered and installed (Requirement
 *     6.1, 6.2). Produced by the façade, not the service.
 *   - `install_succeeded_not_found` — the command exited zero but a re-scan
 *     still did not find the binary on PATH. The `InstallService` itself does
 *     not re-scan, so a zero-exit run returns this success signal and the
 *     `CliCatalog` façade re-scans and maps it to `installed` when the binary
 *     then appears.
 *   - `failed` — the command exited non-zero; the entry stays `available` and
 *     the error output is surfaced (Requirement 6.3, 6.5).
 */
export type InstallOutcome =
  | { readonly status: 'confirmation_required'; readonly entryId: string; readonly command: string }
  | { readonly status: 'unconfigured'; readonly entryId: string }
  /** Install must be done by the user in a terminal; nothing ran. */
  | { readonly status: 'manual'; readonly entryId: string; readonly command: string }
  | { readonly status: 'installed'; readonly entryId: string }
  | { readonly status: 'install_succeeded_not_found'; readonly entryId: string }
  | {
      readonly status: 'failed';
      readonly entryId: string;
      readonly exitCode: number;
      readonly errorOutput: string;
    };
