// Secrets proxy shared contract (Requirement 10, Property 6). The real
// macOS Keychain-backed substitution lands in M7 (task 19.3); this module
// fixes the placeholder shape and the detection grammar now so adapters,
// orchestrator, and the egress seam all agree on it.
//
// A SecretPlaceholder is the ONLY representation of a secret an adapter or any
// persisted/logged/IPC surface is ever allowed to hold. It carries a lookup
// key (`secretId`) and the literal `token` that appears inline in a request;
// it never carries the value, a partial value, or a derived value.

/** The inline token grammar: `{{SECRET:<secretId>}}`. */
export const SECRET_TOKEN_PATTERN = /\{\{SECRET:([^}]+)\}\}/g;

/** Matches a string that is exactly one placeholder token, nothing else. */
export const SECRET_TOKEN_EXACT = /^\{\{SECRET:([^}]+)\}\}$/;

export interface SecretPlaceholder {
  /** The literal inline token, e.g. "{{SECRET:stripe_key}}". */
  token: string;
  /** Lookup key for the real secret. Non-empty; never the value. */
  secretId: string;
}

/** Build the canonical token string for a given secretId. */
export function secretToken(secretId: string): string {
  return `{{SECRET:${secretId}}}`;
}

/**
 * Construct a SecretPlaceholder from a secretId. The returned object carries
 * only the lookup key and the inline token — never a value.
 *
 * @throws if `secretId` is empty, blank, or contains the `}` delimiter (which
 *   would make the token un-parseable).
 */
export function makeSecretPlaceholder(secretId: string): SecretPlaceholder {
  const id = secretId.trim();
  if (id === '') {
    throw new Error('SecretPlaceholder requires a non-empty secretId');
  }
  if (id.includes('}')) {
    throw new Error('secretId must not contain the "}" delimiter');
  }
  return { token: secretToken(id), secretId: id };
}

/** True when `value` is a well-formed SecretPlaceholder (shape guard only). */
export function isSecretPlaceholder(value: unknown): value is SecretPlaceholder {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['token'] === 'string' &&
    typeof candidate['secretId'] === 'string' &&
    candidate['secretId'].trim() !== '' &&
    candidate['token'] === secretToken(candidate['secretId'] as string)
  );
}

/**
 * Scan an arbitrary request value and collect every distinct placeholder token
 * referenced anywhere inside its string content. Walks objects and arrays;
 * cycles are handled. Each secretId is reported once.
 */
export function findPlaceholders(request: unknown): SecretPlaceholder[] {
  const found = new Map<string, SecretPlaceholder>();
  const seen = new WeakSet<object>();

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(SECRET_TOKEN_PATTERN)) {
        const secretId = match[1];
        if (secretId !== undefined && secretId.trim() !== '') {
          found.set(secretId, { token: match[0], secretId });
        }
      }
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      walk(child);
    }
  };

  walk(request);
  return [...found.values()];
}
