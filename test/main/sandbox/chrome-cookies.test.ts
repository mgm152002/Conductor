import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cookieKey, decryptCookie, toCdpCookie } from '@main/sandbox/chrome-cookies';

const seal = (plain: Buffer, key: Buffer): Buffer => {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
};

describe('chrome cookies', () => {
  const key = cookieKey('keychain-secret');

  it('decrypts v10 values, dropping the host hash of newer databases', () => {
    expect(decryptCookie(seal(Buffer.from('abc'), key), key, 20)).toBe('abc');
    expect(decryptCookie(seal(Buffer.concat([Buffer.alloc(32, 1), Buffer.from('abc')]), key), key, 24)).toBe('abc');
  });

  it('leaves out values it cannot read', () => {
    expect(decryptCookie(Buffer.from('v11xxxx'), key, 24)).toBeUndefined();
    expect(decryptCookie(seal(Buffer.from('abc'), key), cookieKey('wrong'), 20)).toBeUndefined();
  });

  it('converts a row for DevTools', () => {
    const future = (Date.now() / 1000 + 3600 + 11_644_473_600) * 1e6;
    const row = { host_key: '.google.com', name: 'SID', value: '', enc: '', path: '/', expires_utc: future, is_secure: 1, is_httponly: 1, samesite: 0 };
    expect(toCdpCookie(row, 'v')).toMatchObject({ domain: '.google.com', secure: true, httpOnly: true, sameSite: 'None' });
    expect(toCdpCookie(row, 'v').expires).toBeGreaterThan(Date.now() / 1000);
    expect(toCdpCookie({ ...row, is_secure: 0, expires_utc: 0 }, 'v')).not.toHaveProperty('sameSite');
    expect(toCdpCookie({ ...row, expires_utc: 0 }, 'v')).not.toHaveProperty('expires');
  });
});
