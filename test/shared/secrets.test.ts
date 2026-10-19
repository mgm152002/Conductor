import { describe, expect, it } from 'vitest';
import {
  findPlaceholders,
  isSecretPlaceholder,
  makeSecretPlaceholder,
  secretToken,
} from '@shared/secrets';

describe('makeSecretPlaceholder', () => {
  it('builds a placeholder carrying only the token and secretId', () => {
    const p = makeSecretPlaceholder('stripe_key');
    expect(p).toEqual({
      token: '{{SECRET:stripe_key}}',
      secretId: 'stripe_key',
    });
  });

  it('trims surrounding whitespace from the secretId', () => {
    expect(makeSecretPlaceholder('  api  ')).toEqual({
      token: '{{SECRET:api}}',
      secretId: 'api',
    });
  });

  it('rejects an empty or blank secretId', () => {
    expect(() => makeSecretPlaceholder('')).toThrow(/non-empty/);
    expect(() => makeSecretPlaceholder('   ')).toThrow(/non-empty/);
  });

  it('rejects a secretId containing the } delimiter', () => {
    expect(() => makeSecretPlaceholder('bad}id')).toThrow(/delimiter/);
  });
});

describe('isSecretPlaceholder', () => {
  it('accepts a well-formed placeholder', () => {
    expect(isSecretPlaceholder(makeSecretPlaceholder('x'))).toBe(true);
  });

  it('rejects objects whose token does not match the secretId', () => {
    expect(
      isSecretPlaceholder({ token: '{{SECRET:a}}', secretId: 'b' }),
    ).toBe(false);
  });

  it('rejects non-objects and empty secretIds', () => {
    expect(isSecretPlaceholder(null)).toBe(false);
    expect(isSecretPlaceholder('string')).toBe(false);
    expect(isSecretPlaceholder({ token: '{{SECRET:}}', secretId: '' })).toBe(
      false,
    );
  });
});

describe('findPlaceholders', () => {
  it('finds tokens embedded in strings within nested structures', () => {
    const request = {
      headers: { Authorization: `Bearer ${secretToken('api_key')}` },
      body: ['prefix', { note: secretToken('db_pass') }],
    };
    const found = findPlaceholders(request).map((p) => p.secretId).sort();
    expect(found).toEqual(['api_key', 'db_pass']);
  });

  it('reports each distinct secretId once', () => {
    const t = secretToken('k');
    const found = findPlaceholders({ a: t, b: t, c: `${t} ${t}` });
    expect(found).toEqual([{ token: t, secretId: 'k' }]);
  });

  it('returns an empty list when there are no tokens', () => {
    expect(findPlaceholders({ a: 1, b: 'plain', c: [true, null] })).toEqual([]);
  });

  it('handles circular references without throwing', () => {
    const cyclic: Record<string, unknown> = { token: secretToken('loop') };
    cyclic['self'] = cyclic;
    expect(findPlaceholders(cyclic)).toEqual([
      { token: '{{SECRET:loop}}', secretId: 'loop' },
    ]);
  });
});
