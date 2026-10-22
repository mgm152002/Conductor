import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Mem0Client } from '@main/domain/mem0-client';

let root: string;
let connectionFile: string;
beforeEach(() => {
  vi.stubEnv('CONDUCTOR_MEM0_URL', undefined);
  vi.stubEnv('CONDUCTOR_MEM0_API_KEY', undefined);
  root = mkdtempSync(join(tmpdir(), 'mem0-connection-'));
  connectionFile = join(root, 'connection.json');
  writeFileSync(connectionFile, JSON.stringify({ url: 'http://127.0.0.1:8000', apiKey: 'local-test-key' }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function transport() {
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ id: 'test', memory: 'Test response' }));
  };
  return { calls, fetcher };
}

it('loads the saved local connection without exposing credentials to a caller', async () => {
  const { calls, fetcher } = transport();
  await new Mem0Client({ connectionFile, fetch: fetcher }).get('test');
  expect(calls[0]?.url).toBe('http://127.0.0.1:8000/memories/test');
  expect(calls[0]?.headers.get('X-API-Key')).toBe('local-test-key');
});

it('does not forward the saved local key when a different endpoint overrides the URL', async () => {
  const { calls, fetcher } = transport();
  vi.stubEnv('CONDUCTOR_MEM0_URL', 'https://memory.example.test');
  await new Mem0Client({ connectionFile, fetch: fetcher }).get('test');
  expect(calls[0]?.url).toBe('https://memory.example.test/memories/test');
  expect(calls[0]?.headers.has('X-API-Key')).toBe(false);
});

it('uses an explicitly supplied key for an overridden connection', async () => {
  const { calls, fetcher } = transport();
  await new Mem0Client({ connectionFile, url: 'https://memory.example.test', apiKey: 'explicit-test-key', fetch: fetcher }).get('test');
  expect(calls[0]?.headers.get('X-API-Key')).toBe('explicit-test-key');
});

it('rejects malformed saved configuration with a sanitized error', () => {
  writeFileSync(connectionFile, '{"apiKey":"local-test-key"');
  expect(() => new Mem0Client({ connectionFile })).toThrow('Invalid local Mem0 connection configuration');
});
