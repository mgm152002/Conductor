import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYCHAIN_SERVICE,
  KeychainReadError,
  KeychainSecretResolver,
  defaultKeychainQueryMapper,
  type KeychainQuery,
  type KeychainReader,
} from '@main/secrets/keychain-resolver';
import {
  SecretsProxy,
  type AuditRecorder,
  type PermissionGate,
} from '@main/secrets/secrets-proxy';
import { secretToken } from '@shared/secrets';

// ---------------------------------------------------------------------------
// Task 19.3 — macOS Keychain-backed secrets proxy egress.
// Validates: Requirements 10.2, 10.3, 10.4, 10.6 (Property 6).
//
// The resolver reads real values through the injectable `KeychainReader` seam,
// so these tests run without a real Keychain. They cover the three abort paths
// the task calls out — a Keychain read failure, an unresolved secretId, and a
// disallowed permission profile — plus the confinement guarantees (no value is
// ever logged/persisted/audited, and the transient value is not retained).
// ---------------------------------------------------------------------------

interface RecordedEvent {
  actor: string;
  action: string;
  target?: string;
  redactedPayload: unknown;
}

function recorder(): AuditRecorder & { events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    events,
    append: (event) => {
      events.push(event);
    },
  };
}

const allowAll: PermissionGate = { allows: () => true };
const denyAll: PermissionGate = { allows: () => false };

/** A reader scripted from a map of account -> value (null = not found). */
function mapReader(items: Record<string, string>): KeychainReader & {
  queries: KeychainQuery[];
} {
  const queries: KeychainQuery[] = [];
  return {
    queries,
    read: async (query) => {
      queries.push(query);
      return Object.prototype.hasOwnProperty.call(items, query.account)
        ? (items[query.account] as string)
        : null;
    },
  };
}

/** Deep-scan a value for a raw secret string leaking in. */
function containsValue(value: unknown, needle: string): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.values(value as Record<string, unknown>).some((v) =>
    containsValue(v, needle),
  );
}

describe('defaultKeychainQueryMapper', () => {
  it('maps a secretId to the Conductor service with the id as account', () => {
    expect(defaultKeychainQueryMapper('stripe_key')).toEqual({
      service: DEFAULT_KEYCHAIN_SERVICE,
      account: 'stripe_key',
    });
  });
});

describe('KeychainSecretResolver.resolve', () => {
  it('returns the stored value for a resolvable secretId', async () => {
    const reader = mapReader({ api_key: 'sk-live-REAL' });
    const resolver = new KeychainSecretResolver({ reader });

    await expect(resolver.resolve('api_key')).resolves.toBe('sk-live-REAL');
    // Looked up under the default service with the secretId as the account.
    expect(reader.queries).toEqual([
      { service: DEFAULT_KEYCHAIN_SERVICE, account: 'api_key' },
    ]);
  });

  it('returns undefined when the secretId resolves to no stored item', async () => {
    const reader = mapReader({});
    const resolver = new KeychainSecretResolver({ reader });

    await expect(resolver.resolve('missing')).resolves.toBeUndefined();
  });

  it('rethrows a KeychainReadError when the Keychain read itself fails', async () => {
    const reader: KeychainReader = {
      read: async () => {
        throw new KeychainReadError('locked_secret', 'keychain locked');
      },
    };
    const resolver = new KeychainSecretResolver({ reader });

    await expect(resolver.resolve('locked_secret')).rejects.toBeInstanceOf(
      KeychainReadError,
    );
  });

  it('wraps an arbitrary reader throw into a KeychainReadError carrying the secretId, not a value', async () => {
    const reader: KeychainReader = {
      read: async () => {
        throw new Error('spawn security ENOENT');
      },
    };
    const resolver = new KeychainSecretResolver({ reader });

    await expect(resolver.resolve('k')).rejects.toMatchObject({
      name: 'KeychainReadError',
      secretId: 'k',
    });
    // The error message identifies the secretId and the cause, never a value.
    await resolver.resolve('k').catch((err: unknown) => {
      expect(String(err)).toContain('k');
      expect(String(err)).toContain('ENOENT');
    });
  });

  it('honours a custom query mapper', async () => {
    const reader = mapReader({ 'acct/openai': 'VAL' });
    const resolver = new KeychainSecretResolver({
      reader,
      queryMapper: (id) => ({ service: 'Custom', account: `acct/${id}` }),
    });

    await expect(resolver.resolve('openai')).resolves.toBe('VAL');
    expect(reader.queries).toEqual([
      { service: 'Custom', account: 'acct/openai' },
    ]);
  });

  it('retains no copy of the value after resolving', async () => {
    const reader = mapReader({ api_key: 'sk-live-REAL' });
    const resolver = new KeychainSecretResolver({ reader });

    await resolver.resolve('api_key');
    // The resolver keeps no cache/field of values: a second read goes back to
    // the reader rather than returning a retained copy.
    reader.queries.length = 0;
    await resolver.resolve('api_key');
    expect(reader.queries).toHaveLength(1);
  });
});

// End-to-end through the proxy with the real resolver wired in, exercising the
// three abort paths the task enumerates.
describe('SecretsProxy with KeychainSecretResolver', () => {
  it('substitutes the real Keychain value only at the transport (10.2, 10.6)', async () => {
    const audit = recorder();
    const reader = mapReader({ api_key: 'sk-live-REAL' });
    const proxy = new SecretsProxy(
      new KeychainSecretResolver({ reader }),
      allowAll,
      audit,
    );

    let seenByTransport: unknown;
    const request = { auth: `Bearer ${secretToken('api_key')}` };
    await proxy.egressRequest(
      { request, adapterId: 'adapter-1', target: 'api.stripe.com' },
      async (resolved) => {
        seenByTransport = resolved;
        return 'ok';
      },
    );

    // Real value appears only at egress.
    expect(containsValue(seenByTransport, 'sk-live-REAL')).toBe(true);
    // Never in the adapter-held request nor in any audit payload.
    expect(containsValue(request, 'sk-live-REAL')).toBe(false);
    for (const ev of audit.events) {
      expect(containsValue(ev.redactedPayload, 'sk-live-REAL')).toBe(false);
    }
  });

  it('aborts with resolver_error and audits the cause on a Keychain read failure (10.3)', async () => {
    const audit = recorder();
    const reader: KeychainReader = {
      read: async () => {
        throw new KeychainReadError('api_key', 'keychain locked');
      },
    };
    const proxy = new SecretsProxy(
      new KeychainSecretResolver({ reader }),
      allowAll,
      audit,
    );

    let transportCalled = false;
    await expect(
      proxy.egressRequest(
        {
          request: secretToken('api_key'),
          adapterId: 'adapter-1',
          target: 'api.stripe.com',
        },
        async () => {
          transportCalled = true;
          return 'nope';
        },
      ),
    ).rejects.toMatchObject({
      name: 'EgressAbortedError',
      reason: 'resolver_error',
      secretId: 'api_key',
    });

    expect(transportCalled).toBe(false);
    const ev = audit.events.find((e) => e.action === 'secret_resolve_failed');
    expect(ev).toBeDefined();
    expect(ev?.redactedPayload).toMatchObject({ secretId: 'api_key' });
    // The audited cause mentions the failure, never a secret value.
    expect(containsValue(ev?.redactedPayload, 'keychain locked')).toBe(true);
    // No egress was performed.
    expect(audit.events.some((e) => e.action === 'egress')).toBe(false);
  });

  it('aborts with secret_unresolved when the secretId does not resolve (10.3)', async () => {
    const audit = recorder();
    const proxy = new SecretsProxy(
      new KeychainSecretResolver({ reader: mapReader({}) }),
      allowAll,
      audit,
    );

    await expect(
      proxy.egressRequest(
        { request: secretToken('missing'), adapterId: 'a', target: 't' },
        async () => 'unreached',
      ),
    ).rejects.toMatchObject({
      name: 'EgressAbortedError',
      reason: 'secret_unresolved',
      secretId: 'missing',
    });

    expect(audit.events.some((e) => e.action === 'secret_unresolved')).toBe(
      true,
    );
    expect(audit.events.some((e) => e.action === 'egress')).toBe(false);
  });

  it('aborts with permission_denied before any Keychain read on a disallowed profile (10.4)', async () => {
    const audit = recorder();
    let readCalled = false;
    const reader: KeychainReader = {
      read: async () => {
        readCalled = true;
        return 'should-not-be-read';
      },
    };
    const proxy = new SecretsProxy(
      new KeychainSecretResolver({ reader }),
      denyAll,
      audit,
    );

    await expect(
      proxy.egressRequest(
        {
          request: secretToken('api_key'),
          adapterId: 'adapter-1',
          target: 'evil.example.com',
        },
        async () => 'nope',
      ),
    ).rejects.toMatchObject({
      name: 'EgressAbortedError',
      reason: 'permission_denied',
      secretId: 'api_key',
    });

    // Denied before substitution: the Keychain was never touched.
    expect(readCalled).toBe(false);
    const ev = audit.events.find((e) => e.action === 'secret_denied');
    expect(ev).toBeDefined();
    expect(ev?.redactedPayload).toMatchObject({
      secretId: 'api_key',
      target: 'evil.example.com',
    });
    expect(ev?.actor).toBe('adapter-1');
  });
});
