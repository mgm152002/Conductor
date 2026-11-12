import { afterEach, describe, expect, it } from 'vitest';
import { PhoneServer, PHONE_CHANNELS } from '@main/phone/phone-server';
import { PhoneControl, qrDataUrl } from '@main/phone/phone-control';

// The phone bridge: pairing, sessions, the action allowlist and the QR code.
// A real loopback server, a fake action router, no ngrok.

const calls: Array<{ channel: string; payload: unknown }> = [];
let server: PhoneServer | undefined;
let base = '';

async function start(): Promise<PhoneServer> {
  calls.length = 0;
  const s = new PhoneServer({ invoke: async (channel, payload) => { calls.push({ channel, payload }); return { ok: true, value: [] }; } });
  base = `http://127.0.0.1:${await s.listen()}`;
  server = s;
  return s;
}
afterEach(async () => { await server?.close(); server = undefined; });

const post = (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body),
});

async function pair(s: PhoneServer): Promise<string> {
  const res = await post('/api/pair', { code: s.newPairing().code });
  return ((await res.json()) as { token: string }).token;
}

describe('phone server', () => {
  it('serves the page with a strict policy, and nothing else without a session', async () => {
    await start();
    const page = await fetch(base);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('Conductor');
    expect((await post('/api/rpc', { channel: 'task.list' })).status).toBe(401);
    expect((await post('/api/rpc', { channel: 'task.list' }, 'a'.repeat(64))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('trades a pairing code once for a session', async () => {
    const s = await start();
    const { code } = s.newPairing();
    const ok = await post('/api/pair', { code });
    expect(ok.status).toBe(200);
    expect(s.devices).toBe(1);
    expect((await post('/api/pair', { code })).status).toBe(401); // single use
    expect((await post('/api/pair', { code: 'nope' })).status).toBe(401);
  });

  it('rejects expired codes and slows guessing down', async () => {
    let now = 1_000_000;
    const s = new PhoneServer({ invoke: async () => ({ ok: true, value: null }), now: () => now });
    base = `http://127.0.0.1:${await s.listen()}`; server = s;
    const { code } = s.newPairing();
    now += 11 * 60_000;
    expect((await post('/api/pair', { code })).status).toBe(401);
    for (let i = 0; i < 10; i += 1) await post('/api/pair', { code: 'x' });
    expect((await post('/api/pair', { code: s.newPairing().code })).status).toBe(429);
  });

  it('only runs allowlisted actions, and never grants a standing approval', async () => {
    const s = await start();
    const token = await pair(s);
    expect((await post('/api/rpc', { channel: 'task.list', payload: { limit: 5 } }, token)).status).toBe(200);
    for (const channel of ['settings.set', 'secret.delete', 'mcp.add', 'task.deleteThread', 'workspace.delete', 'dataControl.delete']) {
      expect(PHONE_CHANNELS.has(channel)).toBe(false);
      expect((await post('/api/rpc', { channel, payload: {} }, token)).status).toBe(403);
    }
    await post('/api/rpc', { channel: 'approval.resolve', payload: { approvalId: 'x', decision: 'approved', remember: true } }, token);
    expect(calls.at(-1)).toEqual({ channel: 'approval.resolve', payload: { approvalId: 'x', decision: 'approved' } });
  });

  it('refuses calls from another website and signs phones out', async () => {
    const s = await start();
    const token = await pair(s);
    expect((await post('/api/rpc', { channel: 'task.list' }, token, { origin: 'https://evil.example' })).status).toBe(403);
    s.revokeAll();
    expect((await post('/api/rpc', { channel: 'task.list' }, token)).status).toBe(401);
  });
});

describe('phone control', () => {
  it('opens a tunnel, shows a QR for a pairing link, and closes everything on stop', async () => {
    let stopped = false;
    const control = new PhoneControl({
      invoke: async () => ({ ok: true, value: null }),
      ngrokPath: () => '/bin/ngrok',
      tunnel: async () => ({ url: 'https://example.ngrok.app', stop: () => { stopped = true; } }),
    });
    const status = await control.start();
    expect(status.state).toBe('on');
    expect(status.pairUrl).toMatch(/^https:\/\/example\.ngrok\.app\/#pair=[0-9a-f]{36}$/);
    expect(status.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect((await control.stop()).state).toBe('off');
    expect(stopped).toBe(true);
  });

  it('explains a missing ngrok, and a tunnel that fails', async () => {
    const missing = await new PhoneControl({ invoke: async () => ({ ok: true, value: null }), ngrokPath: () => undefined }).start();
    expect(missing.state).toBe('error');
    expect(missing.error).toMatch(/brew install ngrok/);
    const failed = await new PhoneControl({ invoke: async () => ({ ok: true, value: null }), ngrokPath: () => '/bin/ngrok', tunnel: async () => { throw new Error('ngrok needs an account token.'); } }).start();
    expect(failed.error).toBe('ngrok needs an account token.');
    expect(failed.state).toBe('error');
  });

  it('makes a QR code', () => { expect(qrDataUrl('https://x.example/#pair=abc').length).toBeGreaterThan(200); });
});

describe('phone work list, uploads and live watch', () => {
  const W = '11111111-1111-4111-8111-111111111111';
  const task = (id: string, state: string, updatedAt: string, extra: object = {}) => ({ id, workspaceId: W, objective: `Task ${id}`, acceptanceCriteria: [], state, contextRefs: [], createdAt: updatedAt, updatedAt, ...extra });
  const tasks = [task('a1', 'RUNNING', '2026-11-12T10:00:00Z'), task('a2', 'COMPLETED', '2026-11-12T09:00:00Z'), task('a3', 'COMPLETED', '2026-11-12T08:00:00Z')];

  it('groups threads into the desktop’s tiers and lets a phone settle one', async () => {
    const { ThreadTierStore } = await import('@main/phone/thread-tier-store');
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    const tiers = new ThreadTierStore(join(mkdtempSync(join(tmpdir(), 'tiers-')), 't.json'));
    const s = new PhoneServer({ tiers, invoke: async (channel) => ({ ok: true, value: channel === 'task.list' ? tasks : channel === 'agents.sandbox.threads' ? { a3: 'agent-1' } : [] }) });
    base = `http://127.0.0.1:${await s.listen()}`; server = s;
    const token = await pair(s);
    const read = async () => ((await (await post('/api/work', {}, token)).json()) as { value: { groups: Array<{ id: string; threads: Array<{ key: string }> }>; agentChats: Array<{ key: string }> } }).value;
    let work = await read();
    expect(work.groups.map((g) => g.id)).toEqual(['needs-attention', 'working']);
    expect(work.agentChats.map((c) => c.key)).toEqual(['a3']); // agent chats stay out of Work
    expect((await post('/api/tier', { key: 'a2', action: 'settle' }, token)).status).toBe(200);
    work = await read();
    expect(work.groups.map((g) => g.id)).toEqual(['working', 'settled']);
    expect((await post('/api/tier', { key: 'a2', action: 'clear' }, token)).status).toBe(200);
    expect((await read()).groups.map((g) => g.id)).toEqual(['needs-attention', 'working']);
    expect((await post('/api/tier', { key: 'a2', action: 'snooze', until: '2000-01-01T00:00:00Z' }, token)).status).toBe(400);
    // Filtering to another project leaves nothing.
    const other = ((await (await post('/api/work', { workspaceId: '22222222-2222-4222-8222-222222222222' }, token)).json()) as { value: { groups: unknown[] } }).value;
    expect(other.groups).toEqual([]);
  });

  it('finds older agent chats that fall outside the latest tasks', async () => {
    const old = task('old1', 'COMPLETED', '2026-01-01T00:00:00Z');
    const s = new PhoneServer({ invoke: async (channel, payload) => ({ ok: true, value:
      channel === 'task.list' ? [tasks[0]] : channel === 'agents.sandbox.threads' ? { old1: 'agent-1' } : channel === 'agents.workspace' ? 'hidden-ws'
        : channel === 'task.thread' ? ((payload as { threadId: string }).threadId === 'old1' ? [old] : []) : [] }) });
    base = `http://127.0.0.1:${await s.listen()}`; server = s;
    const token = await pair(s);
    const work = ((await (await post('/api/work', {}, token)).json()) as { value: { agentChats: Array<{ key: string }> } }).value;
    expect(work.agentChats.map((c) => c.key)).toEqual(['old1']);
  });

  it('stores a photo from the phone as an attachment', async () => {
    const s = await start();
    const token = await pair(s);
    const res = await fetch(`${base}/api/upload?name=${encodeURIComponent('a b.png')}&type=image/png`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(200);
    expect(calls.at(-1)!.channel).toBe('attachment.ingestBytes');
    expect(calls.at(-1)!.payload).toMatchObject({ name: 'a b.png', mimeType: 'image/png' });
    expect((await fetch(`${base}/api/upload`, { method: 'POST', body: 'x' })).status).toBe(401);
  });

  it('shows a running sandbox through the server without exposing its key', async () => {
    const { createServer } = await import('node:http');
    const seen: Array<{ key: unknown; url: string | undefined }> = [];
    const upstream = createServer((req, res) => { seen.push({ key: req.headers['x-aio-api-key'], url: req.url }); res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }); res.end('<html>desktop</html>'); });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    try {
      const s = new PhoneServer({ invoke: async () => ({ ok: true, value: null }), sandboxEndpoint: (id) => (id === 'agent-1' ? { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'secret-key' } : undefined) });
      base = `http://127.0.0.1:${await s.listen()}`; server = s;
      const token = await pair(s);
      expect((await post('/api/watch', { agentId: 'nope' }, token)).status).toBe(409);
      const { value } = (await (await post('/api/watch', { agentId: 'agent-1' }, token)).json()) as { value: { src: string } };
      expect(value.src).toMatch(/^\/w\/[0-9a-f]{48}\/vnc\/index\.html\?/);
      expect(value.src).not.toContain('secret-key');
      const page = await fetch(`${base}${value.src}`);
      expect(await page.text()).toContain('desktop');
      expect(page.headers.get('x-frame-options')).toBeNull();
      expect(seen[0]!.key).toBe('secret-key');
      expect((await fetch(`${base}/w/${'0'.repeat(48)}/vnc/index.html`)).status).toBe(404);
      s.revokeAll();
      expect((await fetch(`${base}${value.src}`)).status).toBe(404);
    } finally { upstream.close(); }
  });
});
