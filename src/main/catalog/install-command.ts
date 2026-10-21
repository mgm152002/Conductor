// Command derivation: the single source that turns a confirmed `InstallMethod`
// into a `ResolvedCommand`. It is deliberately the ONLY place a catalog entry's
// install command is built, so the string shown to the user (`display`) and the
// argv actually spawned (`executable` + `args`) are derived from the same data
// and cannot diverge (Requirement 5.4, 5.5).
//
// The derivation is argv-form throughout — there is no `shell: true` and no
// pipe-to-shell. Even a `script` install method is represented as an
// `executable` plus an `args` array (a plain whitespace tokenization of the
// configured command), while its `display` is the configured command string
// shown verbatim. An `unconfigured` entry yields no command: it throws
// `EntryUnconfiguredError` rather than guessing one (Requirement 5.7).

import type { CatalogEntry, InstallMethod } from '@shared/catalog';
import { EntryUnconfiguredError } from '@shared/catalog';

import type { ResolvedCommand } from './command-runner';

/**
 * Resolve a catalog entry's confirmed install method into the exact command to
 * show and run. The returned `ResolvedCommand.display` is built from the same
 * `executable`/`args` that would be spawned, so the command shown to the user
 * is literally the command that runs (Requirement 5.4, 5.5).
 *
 * Mapping (macOS, per design.md "Command derivation"):
 *   - `{ kind: 'npm', package }`   → `npm install -g <package>`
 *   - `{ kind: 'brew', formula }`  → `brew install <formula>`
 *   - `{ kind: 'script', command }`→ the exact `command`, shown and run verbatim
 *   - `{ kind: 'unconfigured' }`   → throws {@link EntryUnconfiguredError}
 *
 * @throws EntryUnconfiguredError when the entry's install method is
 *   `unconfigured` — an unconfigured entry never produces a command.
 */
export function resolveCommand(entry: CatalogEntry): ResolvedCommand {
  const method: InstallMethod = entry.installMethod;

  switch (method.kind) {
    case 'npm': {
      // `npm install -g <package>` in argv-form. display is rendered from the
      // same executable/args so shown === run.
      const executable = 'npm';
      const args = ['install', '-g', method.package];
      return { executable, args, display: toDisplay(executable, args) };
    }
    case 'brew': {
      // `brew install <formula>` in argv-form.
      const executable = 'brew';
      const args = ['install', method.formula];
      return { executable, args, display: toDisplay(executable, args) };
    }
    case 'script': {
      // The configured command is shown verbatim and run verbatim. We split it
      // on whitespace into an executable (first token) plus args (the rest) so
      // it is spawned in argv-form — never via a shell. The `display` stays the
      // original command string exactly, so the shown form matches the argv we
      // run for this configured command.
      const tokens = method.command.trim().split(/\s+/).filter((t) => t.length > 0);
      const [executable, ...args] = tokens;
      if (executable === undefined) {
        // A blank/whitespace-only script command is not a runnable command.
        throw new EntryUnconfiguredError(entry.id);
      }
      return { executable, args, display: method.command };
    }
    case 'brew_cask': {
      const executable = 'brew';
      const args = ['install', '--cask', method.cask];
      return { executable, args, display: toDisplay(executable, args) };
    }
    case 'manual':
      // Pipe-to-shell installers are never run by Conductor; see InstallService.
      throw new EntryUnconfiguredError(entry.id);
    case 'unconfigured':
      // No command exists for an unconfigured entry — reject rather than guess.
      throw new EntryUnconfiguredError(entry.id);
    default:
      // Exhaustiveness guard: if `InstallMethod` grows a new kind, this fails
      // to compile until the new case is handled here.
      return assertNever(method);
  }
}

/**
 * Render the human-readable command string from the argv form. This is the one
 * place the display string is built, so every `ResolvedCommand.display` for an
 * executable/args pair is produced identically.
 */
function toDisplay(executable: string, args: readonly string[]): string {
  return [executable, ...args].join(' ');
}

/** Compile-time exhaustiveness guard over the `InstallMethod` union. */
function assertNever(value: never): never {
  throw new Error(`Unhandled install method: ${JSON.stringify(value)}`);
}
