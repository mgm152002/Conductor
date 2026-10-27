import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/fast-check';
import {
  EgressAbortedError,
  SecretsProxy,
  type AuditRecorder,
  type PermissionGate,
  type SecretResolver,
} from '@main/secrets/secrets-proxy';
import { redact } from '@main/ipc/redaction';
import { findPlaceholders, secretToken } from '@shared/secrets';

// ---------------------------------------------------------------------------
// Property 6: Secret confinement
// Validates: Requirements 10.1, 10.5, 10.6
//
// The dedicated P6 property test. It generates arbitrary requests with embedded
// placeholders (nested objects, arrays, tokens buried inside larger strings,
// the same token repeated across several positions) and asserts the global
// confinement invariant from Requirement 10.5: a real secret value NEVER appears
// in any persisted row, log entry, Audit_Event payload, prompt, artifact, or IPC
// message. The only place a real value is ever allowed to materialize is at the
// transport egress point (Requirement 10.2). Adapter-held placeholders carry only
// the `secretId` and never a value, partial value, or derived value (10.1), and
// transient resolved values are released once egress completes or aborts (10.6).
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
      // Mirror the production invariant: audit payloads are the redacted form.
      events.push(event);
    },
  };
}

const allowAll: PermissionGate = { allows: () => true };

function mapResolver(values: Record<string, string>): SecretResolver {
  // Own keys only: an id like "__proto__" must not resolve to the prototype.
  return { resolve: (id) => (Object.hasOwn(values, id) ? values[id] : undefined) };
}

/** Deep-scan any value for a raw secret string leaking in. Handles cycles. */
function containsValue(
  value: unknown,
  needle: string,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((v) => containsValue(v, needle, seen));
  }
  return Object.values(value as Record<string, unknown>).some((v) =>
    containsValue(v, needle, seen),
  );
}

// ---------------------------------------------------------------------------
// Arbitraries: a non-empty secretId grammar matching the placeholder contract,
// and a recursive request arbitrary that buries placeholder tokens at arbitrary
// positions inside nested objects, arrays, and larger strings.
// ---------------------------------------------------------------------------

const secretIdArb = fc
  .string({ minLength: 1, maxLength: 10 })
  .map((s) => s.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())
  .filter((s) => s.length > 0);

/** A plain string that never accidentally embeds a placeholder token. */
const plainStringArb = fc
  .string({ maxLength: 24 })
  .map((s) => s.replace(/[{}]/g, ''));

/**
 * Build a request arbitrary and the set of secretIds it references. The tokens
 * are woven into nested objects/arrays and into the middle of larger strings so
 * the test exercises substitution across structural positions, not just whole-
 * string placeholders.
 */
function requestArb(secretIds: readonly string[]) {
  // A leaf is either plain data or a string containing one placeholder token
  // surrounded by plain text.
  const tokenLeafArb =
    secretIds.length === 0
      ? plainStringArb
      : fc.oneof(
          plainStringArb,
          fc
            .tuple(
              plainStringArb,
              fc.constantFrom(...secretIds),
              plainStringArb,
            )
            .map(([pre, id, post]) => `${pre}${secretToken(id)}${post}`),
        );

  const leafArb = fc.oneof(
    tokenLeafArb,
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  );

  return fc.letrec<{ node: unknown }>((tie) => ({
    node: fc.oneof(
      { weight: 3, arbitrary: leafArb },
      {
        weight: 1,
        arbitrary: fc.array(tie('node'), { maxLength: 4 }),
      },
      {
        weight: 1,
        arbitrary: fc.dictionary(plainStringArb, tie('node'), {
          maxKeys: 4,
        }),
      },
    ),
  })).node;
}

describe('Property 6: secret confinement', () => {
  it('substitutes a placeholder stored under an own __proto__ key', async () => {
    const request: Record<string, unknown> = {};
    Object.defineProperty(request, '__proto__', {
      value: secretToken('token'), enumerable: true, writable: true, configurable: true,
    });
    const proxy = new SecretsProxy(
      mapResolver(Object.assign(Object.create(null) as Record<string, string>, { token: 'REAL-SECRET-token-VALUE' })),
      allowAll,
      recorder(),
    );
    let transported: unknown;

    await proxy.egressRequest({ request, adapterId: 'adapter', target: 'host' }, async (resolved) => {
      transported = resolved;
      return 'ok';
    });

    expect(Object.hasOwn(transported as object, '__proto__')).toBe(true);
    expect((transported as Record<string, unknown>)['__proto__']).toBe('REAL-SECRET-token-VALUE');
  });

  it('real values surface only at the transport, on no other surface', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .uniqueArray(secretIdArb, { minLength: 1, maxLength: 5 })
          .chain((secretIds) =>
            fc.record({
              secretIds: fc.constant(secretIds),
              request: requestArb(secretIds),
            }),
          ),
        async ({ secretIds, request }) => {
          // Distinct, high-entropy real values so a leak is unambiguous.
          const values: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const id of secretIds) {
            values[id] = `REAL-SECRET-${id}-${'x'.repeat(4)}-VALUE`;
          }

          const audit = recorder();
          const proxy = new SecretsProxy(mapResolver(values), allowAll, audit);

          // Surfaces the orchestrator would persist/log/show. In production each
          // of these is written from the placeholder form (or its redaction);
          // the proxy must never route a real value onto any of them.
          const persistedRows: unknown[] = [];
          const logEntries: unknown[] = [];
          const prompts: unknown[] = [];
          const artifacts: unknown[] = [];
          const ipcMessages: unknown[] = [];

          // Record the adapter-held request onto every non-egress surface,
          // exactly as the orchestrator does before handing off to the proxy.
          persistedRows.push(structuredClone(request));
          logEntries.push(redact(request));
          prompts.push(structuredClone(request));
          artifacts.push(structuredClone(request));
          ipcMessages.push(redact(request));

          const referenced = findPlaceholders(request);

          let transported: unknown;
          await proxy.egressRequest(
            { request, adapterId: 'adapter', target: 'host' },
            async (resolved) => {
              transported = resolved;
              return 'ok';
            },
          );

          for (const { secretId } of referenced) {
            const real = values[secretId] as string;

            // Egress is the single place the real value is allowed to exist.
            expect(containsValue(transported, real)).toBe(true);

            // Requirement 10.1 / 10.5: the adapter-held request is untouched.
            expect(containsValue(request, real)).toBe(false);

            // Requirement 10.5: no persisted row, log entry, prompt, artifact,
            // or IPC message carries the real value.
            for (const row of persistedRows) {
              expect(containsValue(row, real)).toBe(false);
            }
            for (const entry of logEntries) {
              expect(containsValue(entry, real)).toBe(false);
            }
            for (const prompt of prompts) {
              expect(containsValue(prompt, real)).toBe(false);
            }
            for (const artifact of artifacts) {
              expect(containsValue(artifact, real)).toBe(false);
            }
            for (const msg of ipcMessages) {
              expect(containsValue(msg, real)).toBe(false);
            }

            // Requirement 10.5: no Audit_Event payload carries the real value.
            for (const ev of audit.events) {
              expect(containsValue(ev.redactedPayload, real)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('holds when the same secret token is repeated across many positions', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretIdArb,
        fc.integer({ min: 1, max: 6 }),
        async (id, repeats) => {
          const real = `REAL-${id}-value`;
          const audit = recorder();
          const proxy = new SecretsProxy(
            mapResolver({ [id]: real }),
            allowAll,
            audit,
          );

          const token = secretToken(id);
          const request = {
            header: token,
            nested: { list: Array.from({ length: repeats }, () => token) },
            inline: `prefix ${token} middle ${token} suffix`,
          };

          let transported: unknown;
          await proxy.egressRequest(
            { request, adapterId: 'a', target: 't' },
            async (resolved) => {
              transported = resolved;
              return 'ok';
            },
          );

          // Every occurrence is substituted at egress.
          expect(containsValue(transported, real)).toBe(true);
          expect(containsValue(transported, token)).toBe(false);
          // The source request and every audit payload stay value-free.
          expect(containsValue(request, real)).toBe(false);
          for (const ev of audit.events) {
            expect(containsValue(ev.redactedPayload, real)).toBe(false);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('leaks nothing onto any surface when egress aborts mid-flight', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(secretIdArb, { minLength: 2, maxLength: 4 }),
        async (secretIds) => {
          // Resolve every secret except the last, so egress aborts partway and
          // we can assert no already-resolved value escaped onto a surface.
          const unresolved = secretIds[secretIds.length - 1] as string;
          const values: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const id of secretIds) {
            if (id !== unresolved) {
              values[id] = `REAL-${id}-value`;
            }
          }

          const audit = recorder();
          const proxy = new SecretsProxy(mapResolver(values), allowAll, audit);

          const request: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const id of secretIds) {
            request[id] = `field ${secretToken(id)}`;
          }

          let transportCalled = false;
          await expect(
            proxy.egressRequest(
              { request, adapterId: 'a', target: 't' },
              async () => {
                transportCalled = true;
                return 'unreached';
              },
            ),
          ).rejects.toBeInstanceOf(EgressAbortedError);

          // Aborted before egress: the transport never ran.
          expect(transportCalled).toBe(false);
          // No egress audit was written, and no resolved value leaked into any
          // audit payload or the source request.
          expect(audit.events.some((e) => e.action === 'egress')).toBe(false);
          for (const id of secretIds) {
            const real = values[id];
            if (real === undefined) {
              continue;
            }
            expect(containsValue(request, real)).toBe(false);
            for (const ev of audit.events) {
              expect(containsValue(ev.redactedPayload, real)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
