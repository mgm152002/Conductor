import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const keyFile = resolve(root, '.runtime/mem0/api-key');
mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
chmodSync(keyFile, 0o600);
const apiKey = readFileSync(keyFile, 'utf8').trim();
if (apiKey.length < 32) throw new Error('Invalid local Mem0 API key');
const target = resolve(homedir(), 'Library/Application Support/Conductor/mem0-connection.json');
if (existsSync(target)) {
  const current = JSON.parse(readFileSync(target, 'utf8'));
  if (current.url !== 'http://127.0.0.1:8000' || current.apiKey !== apiKey) {
    throw new Error('A different Mem0 connection already exists; refusing to overwrite it');
  }
}
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
writeFileSync(target, `${JSON.stringify({ url: 'http://127.0.0.1:8000', apiKey })}\n`, { mode: 0o600 });
chmodSync(target, 0o600);
console.log('Local Mem0 key prepared; Conductor connection saved. Credentials were not printed.');
