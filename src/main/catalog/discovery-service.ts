// The CliDiscoveryService wraps the existing PATH-based discovery so status
// derivation never re-implements PATH walking. Given an entry's candidate
// binary names it returns the first one discovered on PATH, or `undefined` when
// none resolves (including the empty-list case). It holds no catalog knowledge,
// so an injected `CliEnvironment` makes it fully deterministic in tests.

import {
  discoverOnPath,
  defaultCliEnvironment,
  type CliEnvironment,
} from '../adapters/local-cli-adapter';

export interface CliDiscoveryService {
  /**
   * Return the first candidate binary discovered on PATH, or `undefined` when
   * none is. An entry with no candidate names returns `undefined` without
   * searching.
   */
  discover(candidateBinaryNames: readonly string[]): string | undefined;
}

/**
 * Default `CliDiscoveryService` that delegates to `discoverOnPath(name, env)`
 * for each candidate and returns the first hit. The `CliEnvironment` is
 * injectable (defaults to the real process/OS) to keep discovery deterministic
 * under test.
 */
export class DefaultCliDiscoveryService implements CliDiscoveryService {
  private readonly env: CliEnvironment;

  constructor(env: CliEnvironment = defaultCliEnvironment()) {
    this.env = env;
  }

  discover(candidateBinaryNames: readonly string[]): string | undefined {
    for (const name of candidateBinaryNames) {
      const found = discoverOnPath(name, this.env);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
}
