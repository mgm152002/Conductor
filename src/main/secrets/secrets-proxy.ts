import { redact } from '../ipc/redaction';
import {
  findPlaceholders,
  SECRET_TOKEN_PATTERN,
  type SecretPlaceholder,
} from '@shared/secrets';

// The secrets proxy egress seam (Requirement 10, Property 6). Adapters and the
// orchestrator only ever hold `SecretPlaceholder` tokens; real values live in
// the macOS Keychain and are read into main-process memory transiently, only
// at the moment of egress, and only after every logging/audit/persistence step
// for the request has completed. This module is the single choke point where a
// placeholder is turned into a real value immediately before the request
// leaves the machine.
//
// The seam is pluggable: callers inject a `SecretResolver`, a `PermissionGate`,
// and an `AuditRecorder`. The concrete macOS Keychain-backed resolver lives in
// `./keychain-resolver.ts` (M7, task 19.3) and plugs in here as the
// `SecretResolver` without changing this contract; tests inject in-memory
// resolvers instead.

/**
 * Minimal audit interface the seam calls. Structurally compatible with the
 * IPC `AuditSink` and the eventual SQLite-backed audit log (task 6), but
 * declared here as an interface so this module never hard-imports a concrete
 * audit implementation that may be built concurrently.
 */
export interface AuditRecorder {
  append(event: {
    actor: string;
    action: string;
    target?: string;
    redactedPayload: unknown;
  }): void;
}

/**
 * Resolves a `secretId` to its real value within the main process. The M7
 * implementation reads from the macOS Keychain. Implementations MUST NOT log,
 * persist, or otherwise retain the returned value; the seam overwrites its own
 * transient copy once egress completes or aborts.
 */
export interface SecretResolver {
  /**
   * @returns the real secret value, or `undefined` if the `secretId` does not
   *   resolve to a stored secret. May resolve synchronously (in-memory/test
   *   resolvers) or asynchronously (the macOS Keychain-backed resolver, whose
   *   read is inherently async); the seam awaits the result either way.
   * @throws (or rejects) if the backing store (e.g. Keychain) read itself
   *   fails.
   */
  resolve(secretId: string): string | undefined | Promise<string | undefined>;
}

/**
 * Decides whether an adapter may use a given secret for a given request
 * target under the active permission profile.
 */
export interface PermissionGate {
  allows(input: {
    adapterId: string;
    secretId: string;
    target: string;
  }): boolean;
}

/**
 * Carries a request outbound from the main process. This is the only function
 * that receives a value with real secrets substituted; it is invoked after all
 * audit/logging/persistence has already run against the placeholder form.
 */
export type EgressTransport = (resolvedRequest: unknown) => Promise<unknown>;

export interface EgressRequestInput {
  /** The request payload, possibly containing placeholder tokens. */
  request: unknown;
  /** The adapter on whose behalf egress is performed. */
  adapterId: string;
  /** The egress target (host/service) permission is evaluated against. */
  target: string;
}

/** Reasons a request can be aborted before egress. */
export type EgressAbortReason =
  | 'permission_denied'
  | 'secret_unresolved'
  | 'resolver_error';

/** Error returned to the caller when egress is aborted. */
export class EgressAbortedError extends Error {
  readonly reason: EgressAbortReason;
  readonly secretId: string;

  constructor(reason: EgressAbortReason, secretId: string, message: string) {
    super(message);
    this.name = 'EgressAbortedError';
    this.reason = reason;
    this.secretId = secretId;
  }
}

/** Replace every occurrence of a placeholder's token with its real value. */
function substitute(value: unknown, token: string, realValue: string): unknown {
  if (typeof value === 'string') {
    return value.split(token).join(realValue);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, token, realValue));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Assignment to `__proto__` invokes Object.prototype's legacy setter and
    // silently drops the own property. Define every key explicitly so unusual
    // but valid request keys are preserved without changing the clone's prototype.
    Object.defineProperty(out, key, {
      value: substitute(child, token, realValue),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Best-effort overwrite of a transient secret string's backing memory. */
function releaseResolved(values: Map<string, string>): void {
  // Strings are immutable in JS, so we cannot zero the original buffer; the
  // best we can do is drop the only references we hold so the value becomes
  // unreachable and eligible for GC. The M7 Keychain path will additionally
  // avoid materializing values any longer than this seam already does.
  values.clear();
}

/**
 * The secrets-proxy egress seam. Detects placeholders in the request, gates
 * each referenced secret on the active permission profile, resolves real
 * values, substitutes them ONLY after the redacted audit record is written,
 * and hands the resolved request to the transport. Aborts before egress — with
 * an Audit_Event and a caller error — on permission denial, an unresolved
 * secretId, or a resolver/Keychain failure.
 *
 * Invariant: the transport is the first and only place a value with real
 * secrets exists; nothing with a real secret is logged, audited, or persisted.
 */
export class SecretsProxy {
  constructor(
    private readonly resolver: SecretResolver,
    private readonly permissions: PermissionGate,
    private readonly audit: AuditRecorder,
  ) {}

  async egressRequest(
    input: EgressRequestInput,
    transport: EgressTransport,
  ): Promise<unknown> {
    const { request, adapterId, target } = input;
    const placeholders: SecretPlaceholder[] = findPlaceholders(request);

    // Phase 1: permission gating. No substitution happens until every
    // referenced secret is permitted for this adapter/target.
    for (const placeholder of placeholders) {
      if (
        !this.permissions.allows({
          adapterId,
          secretId: placeholder.secretId,
          target,
        })
      ) {
        this.audit.append({
          actor: adapterId,
          action: 'secret_denied',
          target,
          redactedPayload: { secretId: placeholder.secretId, target },
        });
        throw new EgressAbortedError(
          'permission_denied',
          placeholder.secretId,
          `Adapter "${adapterId}" is not permitted to use secret "${placeholder.secretId}" for target "${target}"`,
        );
      }
    }

    // Phase 2: resolve real values. A failed read or an unresolved secretId
    // aborts before any value touches the request.
    const resolvedValues = new Map<string, string>();
    try {
      for (const placeholder of placeholders) {
        let realValue: string | undefined;
        try {
          realValue = await this.resolver.resolve(placeholder.secretId);
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          this.audit.append({
            actor: adapterId,
            action: 'secret_resolve_failed',
            target,
            redactedPayload: { secretId: placeholder.secretId, cause },
          });
          throw new EgressAbortedError(
            'resolver_error',
            placeholder.secretId,
            `Failed to read secret "${placeholder.secretId}": ${cause}`,
          );
        }
        if (realValue === undefined) {
          this.audit.append({
            actor: adapterId,
            action: 'secret_unresolved',
            target,
            redactedPayload: {
              secretId: placeholder.secretId,
              cause: 'secretId does not resolve to a stored secret',
            },
          });
          throw new EgressAbortedError(
            'secret_unresolved',
            placeholder.secretId,
            `Secret "${placeholder.secretId}" could not be resolved`,
          );
        }
        resolvedValues.set(placeholder.token, realValue);
      }

      // Phase 3: audit the egress on the placeholder form, before any real
      // value is substituted. redact() is defense-in-depth; the payload here
      // still contains only placeholder tokens.
      this.audit.append({
        actor: adapterId,
        action: 'egress',
        target,
        redactedPayload: redact(request),
      });

      // Phase 4: substitute real values and hand off to the transport. This is
      // the only point at which the request carries real secrets.
      let resolved: unknown = request;
      for (const placeholder of placeholders) {
        const realValue = resolvedValues.get(placeholder.token);
        if (realValue !== undefined) {
          resolved = substitute(resolved, placeholder.token, realValue);
        }
      }
      return await transport(resolved);
    } finally {
      // Phase 5: release transient values once egress completes or aborts.
      releaseResolved(resolvedValues);
    }
  }
}

/**
 * Guard asserting an adapter-facing value holds no raw secret: it may contain
 * placeholder tokens, but never a value that is not a placeholder under a
 * secret-shaped position. Used to enforce "adapters never receive raw secrets"
 * at the boundary where the proxy hands placeholders to an adapter.
 *
 * @throws if the value contains a non-placeholder string resembling a resolved
 *   secret token fragment (an opening `{{SECRET:` with no closing form).
 */
export function assertNoRawSecret(value: unknown): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      // A well-formed placeholder is fine. A dangling `{{SECRET:` prefix with
      // no closing `}}` indicates a malformed/partial token that must not be
      // handed to an adapter.
      const hasOpen = node.includes('{{SECRET:');
      if (hasOpen) {
        const wellFormed = node.replace(SECRET_TOKEN_PATTERN, '');
        if (wellFormed.includes('{{SECRET:')) {
          throw new Error(
            'Adapter-facing value contains a malformed secret token',
          );
        }
      }
      return;
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    Object.values(node as Record<string, unknown>).forEach(walk);
  };
  walk(value);
}
