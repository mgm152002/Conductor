import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// macOS starts apps from Finder/Dock with PATH=/usr/bin:/bin:/usr/sbin:/sbin,
// so Homebrew, npm and user-level installs (~/.local/bin, nvm) are invisible to
// a packaged Electron app. This builds the PATH a terminal would have: the
// user's login-shell PATH (read once, with a timeout) plus well-known install
// directories. Used for CLI discovery, installs and launching agents.

let cached: string[] | undefined;

function loginShellPath(): string[] {
  const shell = process.env['SHELL'];
  if (shell === undefined || !/^\/[\w/.-]+$/.test(shell)) return [];
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__END__" "$PATH"'], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /__PATH__(.*)__END__/s.exec(out);
    return match?.[1]?.split(delimiter).filter(Boolean) ?? [];
  } catch {
    return [];
  }
}

export function searchPathEntries(): string[] {
  if (cached !== undefined) return cached;
  const home = homedir();
  cached = [...new Set([
    ...(process.env['PATH'] ?? '').split(delimiter),
    ...(process.env['VITEST'] !== undefined ? [] : loginShellPath()),
    join(home, '.local/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.bun/bin'),
    join(home, '.opencode/bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])].filter((entry) => entry.length > 0);
  return cached;
}

/** PATH string for child processes. */
export function searchPath(): string {
  return searchPathEntries().join(delimiter);
}

/** Environment for child processes with the full search PATH. */
export function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: searchPath() };
}
