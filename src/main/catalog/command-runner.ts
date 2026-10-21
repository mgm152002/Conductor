// The CommandRunner seam: the single choke point through which the catalog's
// InstallService executes an install command. It mirrors the injectable-seam
// style of `CliEnvironment` (src/main/adapters/local-cli-adapter.ts): a default
// implementation backed by `node:child_process`, and a shape that tests replace
// with a fake that records the command and returns a scripted exit status so no
// test ever runs a real installer.
//
// invariant (Requirement 5.4, 5.5): a command is always spawned in argv-form —
// an `executable` plus an `args` array — NEVER as a shell string. There is no
// `shell: true` and no blind pipe-to-shell, so the `display` string rendered
// from the same `executable`/`args` is literally the command that runs. The
// shown command and the run command cannot diverge.

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { childEnv, searchPathEntries } from './search-path';

/** Resolve a bare executable name against the full search PATH. */
export function resolveExecutable(name: string): string {
  if (isAbsolute(name)) return name;
  for (const dir of searchPathEntries()) {
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return name;
}

/**
 * A command resolved to its exact run form. `display` is the human-readable
 * string shown to the user; `executable` + `args` are what is actually spawned
 * (argv-form, never a shell string), and `display` is rendered FROM them so the
 * command shown equals the command run (Requirement 5.4, 5.5).
 */
export interface ResolvedCommand {
  /** The exact human-readable command string shown to the user. */
  display: string;
  /** The executable actually spawned. */
  executable: string;
  /** The argv passed to the executable — argv-form, never a shell string. */
  args: string[];
}

/** The captured outcome of running a {@link ResolvedCommand}. */
export interface CommandRunResult {
  /** The process exit code (0 on success). */
  exitCode: number;
  /** Everything the process wrote to stdout. */
  stdout: string;
  /** Everything the process wrote to stderr. */
  stderr: string;
}

/**
 * Runs a resolved command and returns its exit status and captured output.
 * Injectable: the default implementation uses `node:child_process`, while tests
 * inject a fake that records the command and returns a scripted result.
 */
export interface CommandRunner {
  run(command: ResolvedCommand): Promise<CommandRunResult>;
}

/**
 * The default runner, backed by `node:child_process`. It spawns the command in
 * argv-form — `executable` with `args` — capturing stdout/stderr and mapping
 * the exit code into the result.
 *
 * It NEVER uses a shell: no `shell: true`, no string command, no pipe-to-shell.
 * A command that exits via a signal (e.g. SIGKILL) has a `null` exit code,
 * which is reported as a non-zero (`1`) exit so the caller treats it as a
 * failure rather than a success.
 */
export const defaultCommandRunner: CommandRunner = {
  run(command: ResolvedCommand): Promise<CommandRunResult> {
    return new Promise<CommandRunResult>((resolve, reject) => {
      const child = spawn(resolveExecutable(command.executable), command.args, {
        // Explicitly argv-form. No shell, ever.
        shell: false,
        // Finder-launched apps have a minimal PATH; use the terminal's.
        env: { ...childEnv(), HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        reject(err);
      });

      child.on('close', (code) => {
        resolve({
          // A signal-terminated process reports a null code; treat that as a
          // non-zero failure exit rather than a success.
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  },
};
