// Redaction applied to every main -> renderer event payload and to audit
// payloads. Enforces Property 6 (secret confinement) at the IPC boundary: no
// secret value, raw credential, or un-redacted external content leaves the
// main process. The authoritative secrets proxy (task 13) guarantees adapters
// only ever hold placeholders; this is the defense-in-depth layer at egress to
// the renderer.

const REDACTED = '[REDACTED]';

// Field names whose values are never forwarded to the renderer. Matched
// case-insensitively against object keys.
const SENSITIVE_KEYS = [
  'secret',
  'secretvalue',
  'password',
  'passwd',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'accesskey',
  'access_key',
];

// Values resembling a resolved secret (not a placeholder token) are scrubbed.
// Placeholder tokens of the form {{SECRET:id}} are safe to forward.
const PLACEHOLDER_PATTERN = /^\{\{SECRET:[^}]+\}\}$/;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_KEYS.some((s) => normalized === s.replace(/[^a-z]/g, ''));
}

/**
 * Deep-clone `value` with sensitive fields replaced by `[REDACTED]`. Cycles are
 * handled; functions and symbols are dropped. Placeholder secret tokens are
 * preserved (they contain no secret), but any other value under a sensitive
 * key is redacted.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    // CLI streams often carry serialized JSON, environment dumps, or HTTP headers.
    // Scrub recognizable credentials before persistence and IPC, including nested JSON text.
    return value
      .replace(/((?:["']?(?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)["']?)\s*:\s*)(["'])(?!\{\{SECRET:)[^"'\r\n]*\2/gi, '$1"[REDACTED]"')
      .replace(/(\b(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)\s*=\s*)(?!\{\{SECRET:)[^\s"'\r\n]+/g, '$1[REDACTED]')
      .replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s"'\r\n]+/gi, '$1[REDACTED]')
      .replace(/\bsk-(?:proj-|ant-)?[a-zA-Z0-9_-]{16,}\b/g, '[REDACTED]')
      .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[REDACTED]');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      if (typeof child === 'string' && PLACEHOLDER_PATTERN.test(child)) {
        out[key] = child; // placeholder token carries no secret
      } else {
        out[key] = REDACTED;
      }
      continue;
    }
    out[key] = redact(child, seen);
  }
  return out;
}
