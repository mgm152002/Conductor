import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/fast-check';
import {
  assertNoRawSecret,
  EgressAbortedError,
  SecretsProxy,
  type AuditRecorder,
  type PermissionGate,
  type SecretResolver,
} from '@main/secrets/secrets-proxy';
import { secretToken } from '@shared/secrets';

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

function mapResolver(values: Record<string, string>): SecretResolver {
  return { resolve: (id) => values[id] };
}

/** Deep-scan a value for any raw secret string leaking in. */
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

describe('SecretsProxy.egressRequest', () => {
  it('substitutes real values only in the transported request', async () => {
    const audit = recorder();
    const proxy = new SecretsProxy(
      mapResolver({ api_key: 'sk-live-REAL' }),
      allowAll,
      audit,
    );

    let seenByTransport: unknown;
    const request = {
      headers: { Authorization: `Bearer ${secretToken('api_key')}` },
    };
    const result = await proxy.egressRequest(
      { request, adapterId: 'adapter-1', target: 'api.stripe.com' },
      async (resolved) => {
        seenByTransport = resolved;
        return 'ok';
      },
    );

    expect(result).toBe('ok');
    // The transport is the only place the real value appears.
    expect(containsValue(seenByTransport, 'sk-live-REAL')).toBe(true);
    // The original request is untouched (adapters keep placeholders).
    expect(containsValue(request, 'sk-live-REAL')).toBe(false);
    // The egress audit payload never carries the real value.
    const egress = audit.events.find((e) => e.action === 'egress');
    expect(egress).toBeDefined();
    expect(containsValue(egress?.redactedPayload, 'sk-live-REAL')).toBe(false);
  });

  it('aborts with an Audit_Event before substitution on permission denial', async () => {
    const audit = recorder();
    const resolver: SecretResolver = {
      resolve: () => {
        throw new Error('resolver must not be called when denied');
      },
    };
    const proxy = new SecretsProxy(resolver, denyAll, audit);

    let transportCalled = false;
    await expect(
      proxy.egressRequest(
        {
          request: { body: secretToken('api_key') },
          adapterId: 'adapter-1',
          target: 'evil.example.com',
        },
        async () => {
          transportCalled = true;
          return 'nope';
        },
      ),
    ).rejects.toMatchObject({
      name: 'EgressAbortedError',
      reason: 'permission_denied',
      secretId: 'api_key',
    });

    expect(transportCalled).toBe(false);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.action).toBe('secret_denied');
  });

  it('aborts when a secretId does not resolve', async () => {
    const audit = recorder();
    const proxy = new SecretsProxy(mapResolver({}), allowAll, audit);

    await expect(
      proxy.egressRequest(
        {
          request: secretToken('missing'),
          adapterId: 'a',
          target: 't',
        },
        async () => 'unreached',
      ),
    ).rejects.toBeInstanceOf(EgressAbortedError);

    expect(audit.events.some((e) => e.action === 'secret_unresolved')).toBe(
      true,
    );
    expect(audit.events.some((e) => e.action === 'egress')).toBe(false);
  });

  it('aborts and audits when the resolver read fails', async () => {
    const audit = recorder();
    const resolver: SecretResolver = {
      resolve: () => {
        throw new Error('keychain locked');
      },
    };
    const proxy = new SecretsProxy(resolver, allowAll, audit);

    await expect(
      proxy.egressRequest(
        { request: secretToken('k'), adapterId: 'a', target: 't' },
        async () => 'unreached',
      ),
    ).rejects.toMatchObject({ reason: 'resolver_error', secretId: 'k' });

    const ev = audit.events.find((e) => e.action === 'secret_resolve_failed');
    expect(ev).toBeDefined();
    expect(containsValue(ev?.redactedPayload, 'keychain locked')).toBe(true);
  });

  it('passes requests with no placeholders straight through', async () => {
    const audit = recorder();
    const proxy = new SecretsProxy(mapResolver({}), allowAll, audit);
    const result = await proxy.egressRequest(
      { request: { plain: 'data' }, adapterId: 'a', target: 't' },
      async (resolved) => resolved,
    );
    expect(result).toEqual({ plain: 'data' });
  });
});

describe('assertNoRawSecret', () => {
  it('accepts values containing only well-formed placeholders', () => {
    expect(() =>
      assertNoRawSecret({ auth: `Bearer ${secretToken('k')}` }),
    ).not.toThrow();
  });

  it('rejects a malformed/partial secret token', () => {
    expect(() => assertNoRawSecret({ auth: '{{SECRET:dangling' })).toThrow();
  });
});

// Property-based: no matter the adapter-held request (built only from
// placeholders and plain data), the resolved value handed to the transport
// restores every placeholder to its real value, while the original request and
// every audit payload remain free of real secret values.
// Validates: Requirements 10.2, 10.5
describe('SecretsProxy property: egress confinement', () => {
  it('real values appear only at the transport, never in audit or source', async () => {
    const secretIdArb = fc
      .string({ minLength: 1, maxLength: 8 })
      .map((s) => s.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())
      .filter((s) => s.length > 0);

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(secretIdArb, { minLength: 1, maxLength: 4 }),
        async (secretIds) => {
          const values: Record<string, string> = {};
          for (const id of secretIds) {
            values[id] = `REAL-${id}-value`;
          }
          const audit = recorder();
          const proxy = new SecretsProxy(
            mapResolver(values),
            allowAll,
            audit,
          );

          const request: Record<string, string> = { note: 'plain text' };
          for (const id of secretIds) {
            request[id] = `header ${secretToken(id)}`;
          }

          let transported: unknown;
          await proxy.egressRequest(
            { request, adapterId: 'adapter', target: 'host' },
            async (resolved) => {
              transported = resolved;
              return undefined;
            },
          );

          for (const id of secretIds) {
            const real = values[id] as string;
            // restored at the transport
            expect(containsValue(transported, real)).toBe(true);
            // never in the original adapter-held request
            expect(containsValue(request, real)).toBe(false);
            // never in any audit payload
            for (const ev of audit.events) {
              expect(containsValue(ev.redactedPayload, real)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
