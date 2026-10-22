import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(resolve(homedir(), 'Library/Application Support/Conductor/mem0-connection.json'), 'utf8'));
const scope = `persistence-probe-${randomUUID()}`;
let id;
async function request(path, method = 'GET', body) {
  const response = await fetch(`${config.url}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.ok, true, `Mem0 HTTP ${response.status}`);
  return response.json();
}
try {
  assert.equal((await fetch(`${config.url}/memories?user_id=${scope}`)).status, 401, 'API must require authentication');
  const text = 'My usual journey to the workplace is aboard a railway carriage.';
  const added = await request('/memories', 'POST', { user_id: scope, run_id: scope,
    messages: [{ role: 'user', content: text }], metadata: { conductor_id: scope }, infer: false });
  id = added.results[0].id;
  assert.equal((await request(`/memories/${id}`)).memory, text);
  console.log('Created and inspected a disposable persistence probe. Restarting both services…');
  execFileSync('docker', ['compose', '-f', 'services/mem0/compose.yaml', 'restart'], { cwd: root, stdio: 'ignore' });
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { ready = true; break; }
    } catch { /* model is warming after restart */ }
    await new Promise((done) => setTimeout(done, 1000));
  }
  assert.equal(ready, true, 'Service should recover after restart');
  assert.equal((await request(`/memories/${id}`)).memory, text);
  const hits = await request('/search', 'POST', { query: 'How do I commute to work?',
    filters: { user_id: scope, conductor_id: { in: [scope] } }, top_k: 1 });
  assert.equal(hits.results[0]?.id, id);
  console.log('PASS: authentication, exact content, semantic search, and persistence across both container restarts.');
} finally {
  if (id) await request(`/memories/${id}`, 'DELETE');
  console.log('Disposable probe removed.');
}
