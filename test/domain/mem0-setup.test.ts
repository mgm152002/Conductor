import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Mem0Client } from '../../src/main/domain/mem0-client';

const reply = (status: number): Response => new Response('{}', { status });

it('test() verifies health and the API key without saving', async () => {
  const calls: string[] = [];
  const client = new Mem0Client({ fetch: (async (url: string) => { calls.push(String(url)); return reply(String(url).includes('/health') ? 200 : 401); }) as typeof fetch });
  expect(await client.test({ url: 'http://127.0.0.1:8000/', apiKey: 'bad' })).toEqual({ ok: false, detail: 'Mem0 rejected the API key.' });
  expect(calls[0]).toBe('http://127.0.0.1:8000/health');
  const good = new Mem0Client({ fetch: (async () => reply(200)) as typeof fetch });
  expect(await good.test({ url: 'http://127.0.0.1:8000', apiKey: 'k' })).toEqual({ ok: true });
});

it('test() reports an unreachable service and a bad URL', async () => {
  const down = new Mem0Client({ fetch: (async () => { throw new Error('refused'); }) as typeof fetch });
  expect((await down.test({ url: 'http://127.0.0.1:1', apiKey: 'k' })).ok).toBe(false);
  expect((await down.test({ url: 'not a url', apiKey: 'k' })).ok).toBe(false);
  expect((await down.test({ url: 'http://user:pw@host', apiKey: 'k' })).ok).toBe(false);
});

it('configure() saves a private connection file and switches to it', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mem0-setup-')), 'nested', 'mem0-connection.json');
  const seen: string[] = [];
  const client = new Mem0Client({ connectionFile: file, fetch: (async (url: string) => { seen.push(String(url)); return reply(200); }) as typeof fetch });
  client.configure({ url: 'https://mem0.example.test/', apiKey: ' secret ' });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ url: 'https://mem0.example.test', apiKey: 'secret' });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  await client.health();
  expect(seen[0]).toBe('https://mem0.example.test/health');
  expect(() => new Mem0Client({ connectionFile: file })).not.toThrow();
});
