import { describe, expect, it } from 'vitest';
import { redact } from '@main/ipc/redaction';

describe('redact', () => {
  it('redacts sensitive keys regardless of casing/underscores', () => {
    const out = redact({
      password: 'hunter2',
      API_KEY: 'sk-live-1',
      Authorization: 'Bearer abc',
      nested: { privateKey: 'pk-1', note: 'keep me' },
    }) as Record<string, unknown>;

    expect(out['password']).toBe('[REDACTED]');
    expect(out['API_KEY']).toBe('[REDACTED]');
    expect(out['Authorization']).toBe('[REDACTED]');
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['privateKey']).toBe('[REDACTED]');
    expect(nested['note']).toBe('keep me');
  });

  it('preserves placeholder secret tokens (they carry no value)', () => {
    const out = redact({ token: '{{SECRET:stripe_key}}' }) as Record<
      string,
      unknown
    >;
    expect(out['token']).toBe('{{SECRET:stripe_key}}');
  });

  it('leaves non-sensitive primitives and arrays intact', () => {
    const input = { count: 3, tags: ['a', 'b'], ok: true, nothing: null };
    expect(redact(input)).toEqual(input);
  });

  it('handles circular references without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out['name']).toBe('loop');
    expect(out['self']).toBe('[CIRCULAR]');
  });
});
