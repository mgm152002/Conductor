import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Chrome on macOS encrypts every cookie value with a key kept in the login
// Keychain ("Chrome Safe Storage"). A second Chrome instance cannot read the
// copied values and wipes them on start, so the copied cookies are decrypted
// here and handed to the new Chrome over DevTools (it re-encrypts them itself).

/** A cookie as the DevTools `Storage.setCookies` command takes it. */
export interface CdpCookie { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: 'None' | 'Lax' | 'Strict'; expires?: number }

interface CookieRow { host_key: string; name: string; value: string; enc: string; path: string; expires_utc: number; is_secure: number; is_httponly: number; samesite: number }

const KEYCHAIN_MS = 60_000;

/** The AES key Chrome derives from its Keychain password. */
export function cookieKey(password: string): Buffer { return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1'); }

/** The plain value of one `v10` cookie. Databases from version 24 on prefix the value with a 32-byte host hash. */
export function decryptCookie(encrypted: Buffer, key: Buffer, dbVersion: number): string | undefined {
  if (encrypted.length < 4 || encrypted.subarray(0, 3).toString('latin1') !== 'v10') return undefined;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return (dbVersion >= 24 ? plain.subarray(32) : plain).toString('utf8');
  } catch { return undefined; }
}

const SAME_SITE: Record<number, CdpCookie['sameSite']> = { 0: 'None', 1: 'Lax', 2: 'Strict' };

export function toCdpCookie(row: CookieRow, value: string): CdpCookie {
  const secure = row.is_secure === 1;
  const sameSite = SAME_SITE[row.samesite];
  const expires = row.expires_utc > 0 ? row.expires_utc / 1e6 - 11_644_473_600 : undefined;
  return {
    name: row.name, value, domain: row.host_key, path: row.path || '/', secure, httpOnly: row.is_httponly === 1,
    // SameSite=None is only valid on secure cookies.
    ...(sameSite !== undefined && (sameSite !== 'None' || secure) ? { sameSite } : {}),
    ...(expires !== undefined && expires > Date.now() / 1000 ? { expires } : {}),
  };
}

const run = (file: string, args: string[], timeout: number): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
});

/** Chrome's Safe Storage password. macOS asks the user once, with an "Always Allow" option. */
export async function keychainPassword(): Promise<string> {
  return (await run('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], KEYCHAIN_MS)).replace(/\n$/, '');
}

/** The database a profile folder keeps its cookies in (newer Chrome: Network/Cookies). */
export function cookieDb(profileFolder: string): string | undefined {
  return [join(profileFolder, 'Network', 'Cookies'), join(profileFolder, 'Cookies')].find((path) => existsSync(path));
}

/** Read and decrypt the cookies of a (copied) profile folder. Cookies that cannot be decrypted are left out. */
export async function readCookies(profileFolder: string, password: () => Promise<string> = keychainPassword): Promise<CdpCookie[]> {
  const db = cookieDb(profileFolder);
  if (db === undefined) return [];
  const sql = `select host_key, name, value, hex(encrypted_value) as enc, path, expires_utc, is_secure, is_httponly, samesite from cookies`;
  const [rows, meta] = await Promise.all([
    run('sqlite3', ['-readonly', '-json', db, sql], 30_000),
    run('sqlite3', ['-readonly', db, `select value from meta where key = 'version'`], 10_000).catch(() => '0'),
  ]);
  const list = rows.trim() === '' ? [] : JSON.parse(rows) as CookieRow[];
  const dbVersion = Number.parseInt(meta, 10) || 0;
  const key = list.some((row) => row.enc !== '') ? cookieKey(await password()) : Buffer.alloc(16);
  const out: CdpCookie[] = [];
  for (const row of list) {
    const value = row.enc === '' ? row.value : decryptCookie(Buffer.from(row.enc, 'hex'), key, dbVersion);
    if (value !== undefined) out.push(toCdpCookie(row, value));
  }
  return out;
}
