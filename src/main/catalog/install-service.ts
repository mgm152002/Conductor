// The InstallService gate: the ONLY module that executes a catalog entry's
// install command, and only behind an explicit confirmation gate. It mirrors
// `ResumeService`'s confirmed-flag gate (src/main/orchestrator/resume-service.ts):
// the gate is enforced HERE, in the main process, so a crafted IPC payload
// cannot bypass it. A request without `confirmed === true` returns
// `confirmation_required` and invokes the injected `CommandRunner` ZERO times
// (Requirement 5.2, 5.3).
//
// Command derivation is delegated entirely to `resolveCommand`, the single
// source that builds a `ResolvedCommand` whose `display` string is rendered from
// the same `executable`/`args` it spawns — so the command shown to the user is
// literally the command that runs (Requirement 5.4, 5.5), and an `unconfigured`
// entry never produces one (Requirement 5.7).
//
// Outcome mapping (Requirement 6.3, 6.5): a non-zero exit returns `failed` with
// the exit code and the captured error output while the entry's status stays
// `available`. A zero exit returns a success signal — `install_succeeded_not_found`
// — WITHOUT the service itself re-scanning. The `CliCatalog` façade (task 5.1)
// owns the re-scan + register and maps a zero-exit success to `installed` when
// the binary is then found, or keeps `install_succeeded_not_found` when it is
// still absent.

import type { CatalogEntry, InstallOutcome } from '@shared/catalog';
import { EntryUnconfiguredError } from '@shared/catalog';

import type { CommandRunner } from './command-runner';
import { defaultCommandRunner } from './command-runner';
import { resolveCommand } from './install-command';

/**
 * Executes a catalog entry's install command behind the confirmation gate, and
 * only ever through the injected {@link CommandRunner}. Constructed once beside
 * the rest of the catalog; the façade composes its outcome.
 */
export class InstallService {
  private readonly runner: CommandRunner;

  /**
   * @param runner Injectable command runner. Defaults to
   *   {@link defaultCommandRunner} (backed by `node:child_process`); tests
   *   inject a recording fake so no real installer ever runs.
   */
  constructor(runner: CommandRunner = defaultCommandRunner) {
    this.runner = runner;
  }

  /**
   * The exact command string to display for an entry, derived from its
   * confirmed install method.
   *
   * @throws EntryUnconfiguredError when the entry's install method is
   *   `unconfigured` — an unconfigured entry never produces a command
   *   (Requirement 5.7).
   */
  command(entry: CatalogEntry): string {
    if (entry.installMethod.kind === 'manual') return entry.installMethod.command;
    return resolveCommand(entry).display;
  }

  /**
   * Request an install for an entry behind the confirmation gate.
   *
   *   - An `unconfigured` entry returns `{ status: 'unconfigured' }` and runs
   *     nothing (Requirement 5.7).
   *   - When `confirmed !== true`, returns `{ status: 'confirmation_required',
   *     command }` and invokes the runner ZERO times (Requirement 5.2, 5.3).
   *   - Only when `confirmed === true` does it run the derived command through
   *     the injected runner. A non-zero exit returns `failed` with the exit
   *     code and error output (status stays `available` — Requirement 6.3,
   *     6.5); a zero exit returns the `install_succeeded_not_found` success
   *     signal for the façade to re-scan on (Requirement 6.1).
   */
  async install(entry: CatalogEntry, confirmed: boolean): Promise<InstallOutcome> {
    // Derive the command first. An unconfigured entry has none, so it can never
    // produce an install command — reject rather than guess (Requirement 5.7).
    if (entry.installMethod.kind === 'manual') {
      return { status: 'manual', entryId: entry.id, command: entry.installMethod.command };
    }
    let resolved;
    try {
      resolved = resolveCommand(entry);
    } catch (error) {
      if (error instanceof EntryUnconfiguredError) {
        return { status: 'unconfigured', entryId: entry.id };
      }
      throw error;
    }

    // Confirmation gate (Requirement 5.2, 5.3): without explicit confirmation we
    // run nothing and return the command for the UI's confirm step. The runner
    // is NOT touched on this path.
    if (confirmed !== true) {
      return {
        status: 'confirmation_required',
        entryId: entry.id,
        command: resolved.display,
      };
    }

    // Confirmed: run the derived command through the injected runner.
    let result;
    try {
      result = await this.runner.run(resolved);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      const tool = resolved.executable;
      return {
        status: 'failed',
        entryId: entry.id,
        exitCode: 127,
        errorOutput: missing
          ? `${tool} was not found on this Mac. ${tool === 'brew' ? 'Install Homebrew from https://brew.sh' : 'Install Node.js (which includes npm) from https://nodejs.org'}, then try again.`
          : error instanceof Error ? error.message : String(error),
      };
    }

    if (result.exitCode !== 0) {
      // A non-zero exit is a failure: surface the exit code and error output
      // while the entry's status stays available (Requirement 6.3, 6.5).
      return {
        status: 'failed',
        entryId: entry.id,
        exitCode: result.exitCode,
        errorOutput: result.stderr,
      };
    }

    // A zero exit succeeded. This service does not re-scan — it returns a
    // success signal the CliCatalog façade re-scans on, then maps to `installed`
    // (binary found) or keeps `install_succeeded_not_found` (still absent).
    return { status: 'install_succeeded_not_found', entryId: entry.id };
  }
}
