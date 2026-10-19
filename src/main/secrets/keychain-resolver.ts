// The macOS Keychain-backed SecretResolver (Requirement 10.2, 10.3, 10.6;
// Property 6). This is the concrete resolver the secrets-proxy egress seam
// (src/main/secrets/secrets-proxy.ts) injects at runtime: it turns a
// `secretId` into its real value by reading a generic password from the login
// Keychain within the main process, and only at the moment of egress.
//
// Design notes tying this to the seam and to Property 6:
//   - A real value materializes here only transiently. The resolver reads it,
//     hands it to the proxy, and overwrites/drops its own only reference; the
//     proxy in turn overwrites its transient copy once egress completes or
//     aborts (10.6).
//   - This module NEVER logs, persists, or audits a value. The value is only
//     ever the function's return. Errors carry the `secretId` and a cause, but
//     never the value (10.5).
//   - A `secretId` that resolves to no stored item returns `undefined` (the
//     proxy maps that to a `secret_unresolved` abort, 10.3). An actual backing
//     read failure (Keychain locked, access denied, tooling error) throws a
//     `KeychainReadError` (the proxy maps that to a `resolver_error` abort,
//     10.3).
//
// Keychain access goes through the injectable `KeychainReader` seam so unit
// tests run without a real Keychain, mirroring the `CommandRunner` /
// `CliEnvironment` style used elsewhere in the main process.

import { execFile } from 'node:child_process';

import type { SecretResolver } from './secrets-proxy';

/** The default Keychain service name generic-password items are filed under. */
export const DEFAULT_KEYCHAIN_SERVICE = 'Conductor';

const ENVELOPE = 'b64:';

/** ASCII envelope Conductor writes so `security -w` returns the value verbatim. */
export function encodeKeychainValue(value: string): string {
  return ENVELOPE + Buffer.from(value, 'utf8').toString('base64');
}

/** Decode Conductor's envelope; values written by other tools pass through. */
export function decodeKeychainValue(stored: string): string {
  if (!stored.startsWith(ENVELOPE)) return stored;
  const body = stored.slice(ENVELOPE.length);
  return /^[A-Za-z0-9+/]*={0,2}$/.test(body) ? Buffer.from(body, 'base64').toString('utf8') : stored;
}

/**
 * Raised when the backing Keychain read itself fails — the item store could
 * not be queried at all (Keychain locked, access denied, tooling missing or
 * erroring). This is distinct from "the item does not exist", which a reader
 * reports by returning `null`. The proxy treats this as a `resolver_error`.
 *
 * The message carries the `secretId` and a cause string, never a secret value.
 */
export class KeychainReadError extends Error {
  readonly secretId: string;

  constructor(secretId: string, cause: string) {
    super(`Keychain read failed for secret "${secretId}": ${cause}`);
    this.name = 'KeychainReadError';
    this.secretId = secretId;
  }
}

/**
 * The lookup coordinates for a single Keychain generic-password item. The
 * `secretId` maps to the account; the service groups Conductor's items.
 */
export interface KeychainQuery {
  service: string;
  account: string;
}

/**
 * The injectable Keychain-read seam. Implementations read a single generic
 * password and return its value, or `null` when no such item exists.
 *
 * Contract:
 *   - return the stored value when the item exists;
 *   - return `null` when the item does not exist (unresolved secretId);
 *   - throw (ideally a {@link KeychainReadError}) when the store itself cannot
 *     be read.
 *
 * Implementations MUST NOT log, persist, or retain the value beyond returning
 * it. The default implementation holds it only as a local that goes out of
 * scope immediately.
 */
export interface KeychainReader {
  read(query: KeychainQuery): Promise<string | null>;
}

/**
 * The default reader, backed by the macOS `security` CLI in argv-form (no
 * shell, so no injection surface). `security find-generic-password -w` prints
 * the password to stdout and exits 0 when the item exists; it exits non-zero
 * with "could not be found" (exit 44) when the item is absent.
 *
 * Classification:
 *   - exit 0            -> the value (stdout, trailing newline stripped);
 *   - item-not-found    -> `null` (unresolved secretId);
 *   - any other failure -> throw `KeychainReadError` (backing read failed).
 */
export const defaultKeychainReader: KeychainReader = {
  read({ service, account }: KeychainQuery): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      execFile(
        '/usr/bin/security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        // A Keychain value is small; cap the buffer defensively.
        { maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error === null) {
            // `security -w` emits the raw password plus a trailing newline.
            // Strip exactly one trailing newline; preserve everything else.
            const value = stdout.replace(/\n$/, '');
            resolve(decodeKeychainValue(value));
            return;
          }

          // `security` reports a missing item with exit code 44
          // (errSecItemNotFound) and a "could not be found" message. Treat that
          // as "unresolved", not as a backing-read failure.
          const code = (error as NodeJS.ErrnoException & { code?: number })
            .code;
          const notFound =
            code === 44 ||
            /could not be found/i.test(stderr) ||
            /could not be found/i.test(error.message);
          if (notFound) {
            resolve(null);
            return;
          }

          const cause =
            stderr.trim() !== ''
              ? stderr.trim()
              : error.message || `exit ${String(code ?? 'unknown')}`;
          reject(new KeychainReadError(account, cause));
        },
      );
    });
  },
};

/**
 * Maps a `secretId` to the Keychain query used to look it up. The default maps
 * every secret under {@link DEFAULT_KEYCHAIN_SERVICE} with the `secretId` as
 * the account, which matches how secrets are stored for the proxy.
 */
export type KeychainQueryMapper = (secretId: string) => KeychainQuery;

/** The default mapper: one service, `secretId` as the account. */
export function defaultKeychainQueryMapper(secretId: string): KeychainQuery {
  return { service: DEFAULT_KEYCHAIN_SERVICE, account: secretId };
}

export interface KeychainSecretResolverOptions {
  /** The Keychain-read seam. Defaults to the `security`-CLI reader. */
  reader?: KeychainReader;
  /** Maps a `secretId` to its Keychain query. Defaults to one service. */
  queryMapper?: KeychainQueryMapper;
}

/**
 * The Keychain-backed {@link SecretResolver} the secrets proxy injects at
 * runtime. It reads a single secret from the Keychain on demand, returning the
 * value for the proxy to substitute at egress.
 *
 * Confinement (Property 6):
 *   - the value is held only as the awaited local `value` below and is returned
 *     straight to the caller; this resolver keeps no field, cache, or map of
 *     values, so it retains nothing once `resolve` returns;
 *   - nothing here logs, persists, or audits the value;
 *   - an unresolved `secretId` returns `undefined`; a backing-read failure is
 *     rethrown so the proxy aborts and audits with the cause (never the value).
 */
export class KeychainSecretResolver implements SecretResolver {
  private readonly reader: KeychainReader;
  private readonly queryMapper: KeychainQueryMapper;

  constructor(options: KeychainSecretResolverOptions = {}) {
    this.reader = options.reader ?? defaultKeychainReader;
    this.queryMapper = options.queryMapper ?? defaultKeychainQueryMapper;
  }

  /**
   * Read a single secret from the Keychain. Satisfies the async-aware
   * {@link SecretResolver} contract (the proxy awaits the result).
   *
   * @returns the real value, or `undefined` when `secretId` resolves to no
   *   stored item.
   * @throws {KeychainReadError} when the Keychain read itself fails.
   */
  async resolve(secretId: string): Promise<string | undefined> {
    const query = this.queryMapper(secretId);
    let value: string | null;
    try {
      value = await this.reader.read(query);
    } catch (err) {
      if (err instanceof KeychainReadError) {
        throw err;
      }
      const cause = err instanceof Error ? err.message : String(err);
      throw new KeychainReadError(secretId, cause);
    }

    if (value === null) {
      return undefined;
    }

    // Hand the value back to the proxy and drop our only reference. Strings are
    // immutable in JS so the backing bytes cannot be zeroed, but by not storing
    // `value` anywhere it becomes unreachable the moment this frame returns —
    // the proxy then overwrites its transient copy once egress settles (10.6).
    const out = value;
    value = null;
    return out;
  }
}
