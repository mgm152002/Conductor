import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudBrowserSettings, WebDriverSession, callCloudBrowser, connection, storedZip, testCloudBrowser } from '@main/sandbox/cloud-browser';
import { SandboxGateway } from '@main/sandbox/sandbox-gateway';
import type { GateRequest } from '@main/adapters/tool-gate';

// A fake W3C WebDriver hub: enough of the protocol (session, url, title,
// element, click, value, execute, screenshot) to check what Conductor sends.

let hub: Server;
let base: string;
let seen: Array<{ method: string; path: string; auth: string | undefined; type: string | undefined; body: unknown }>;
let page = 'about:blank';

const body = (req: IncomingMessage): Promise<unknown> => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
  req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(undefined); } });
});

beforeEach(async () => {
  seen = [];
  page = 'about:blank';
  hub = createServer((req, res) => {
    void body(req).then((parsed) => {
      const path = (req.url ?? '').replace(/^\/wd\/hub/, '');
      seen.push({ method: req.method ?? '', path, auth: req.headers.authorization, type: req.headers['content-type'], body: parsed });
      const send = (status: number, value: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value })); };
      if (req.headers.authorization !== `Basic ${Buffer.from('user:secret').toString('base64')}`) { send(401, { error: 'unauthorized', message: 'bad key' }); return; }
      if (req.method === 'POST' && path === '/session') { send(200, { sessionId: 's1', capabilities: {} }); return; }
      if (req.method === 'DELETE' && path === '/session/s1') { send(200, null); return; }
      if (req.method === 'POST' && path === '/session/s1/url') { page = (parsed as { url: string }).url; send(200, null); return; }
      if (req.method === 'GET' && path === '/session/s1/url') { send(200, page); return; }
      if (req.method === 'GET' && path === '/session/s1/title') { send(200, 'Example Domain'); return; }
      if (req.method === 'GET' && path === '/session/s1/screenshot') { send(200, 'iVBORw0KGgo='); return; }
      if (req.method === 'POST' && path === '/session/s1/element') {
        const value = (parsed as { value: string }).value;
        if (value === '#missing') { send(404, { error: 'no such element', message: 'no such element: Unable to locate element\n(stack)' }); return; }
        send(200, { 'element-6066-11e4-a52e-4f735466cecf': 'e1' }); return;
      }
      if (req.method === 'POST' && (path === '/session/s1/element/e1/click' || path === '/session/s1/element/e1/value' || path === '/session/s1/element/e1/clear')) { send(200, null); return; }
      if (req.method === 'POST' && path === '/session/s1/se/file') { send(200, '/tmp/up/resume.pdf'); return; }
      if (req.method === 'POST' && path === '/session/s1/execute/sync') { send(200, 'page text'); return; }
      send(404, { error: 'unknown command', message: path });
    });
  });
  await new Promise<void>((resolve) => { hub.listen(0, '127.0.0.1', resolve); });
  const address = hub.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/wd/hub`;
});
afterEach(async () => { await new Promise<void>((resolve) => { hub.close(() => { resolve(); }); }); });

const withCreds = (): string => base.replace('http://', 'http://user:secret@');
const text = (result: unknown): string => ((result as { content: Array<{ text?: string }> }).content[0]?.text ?? '');

describe('connection', () => {
  it('moves credentials out of the URL into Basic auth, with the utf-8 JSON content type hubs require', () => {
    const conn = connection({ url: 'https://Project-1:abc@hub.example.com/wd/hub/' });
    expect(conn.base).toBe('https://hub.example.com/wd/hub');
    expect(conn.host).toBe('hub.example.com');
    expect(conn.headers['authorization']).toBe(`Basic ${Buffer.from('Project-1:abc').toString('base64')}`);
    expect(conn.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('uses a separate API key as the password', () => {
    const conn = connection({ url: 'https://Project-1@hub.example.com/wd/hub', apiKey: 'k2' });
    expect(conn.headers['authorization']).toBe(`Basic ${Buffer.from('Project-1:k2').toString('base64')}`);
  });

  it('rejects anything but http(s)', () => {
    expect(() => connection({ url: 'file:///etc/passwd' })).toThrow(/https?/);
    expect(() => connection({ url: 'not a url' })).toThrow(/valid URL/);
  });
});

describe('WebDriverSession tools', () => {
  it('opens one session lazily, drives the page and closes it', async () => {
    const browser = new WebDriverSession({ url: withCreds() });
    expect(text(await callCloudBrowser(browser, 'cloud_browser_navigate', { url: 'https://example.com/' }))).toContain('Example Domain');
    expect(text(await callCloudBrowser(browser, 'cloud_browser_type', { selector: 'input[name=q]', text: 'hi', submit: true }))).toContain('Typed into');
    expect(text(await callCloudBrowser(browser, 'cloud_browser_click', { selector: 'a' }))).toContain('Clicked a');
    expect(text(await callCloudBrowser(browser, 'cloud_browser_get_text', {}))).toBe('page text');
    const shot = await callCloudBrowser(browser, 'cloud_browser_screenshot', {}) as { content: Array<{ type: string; data?: string }> };
    expect(shot.content[0]).toMatchObject({ type: 'image', data: 'iVBORw0KGgo=' });
    await browser.close();
    expect(seen.filter((call) => call.path === '/session')).toHaveLength(1);
    expect(seen.some((call) => call.method === 'DELETE' && call.path === '/session/s1')).toBe(true);
    expect(seen.find((call) => call.path === '/session/s1/element/e1/value')?.body).toEqual({ text: 'hi' });
    expect(seen.every((call) => call.method === 'GET' || call.type === 'application/json; charset=utf-8')).toBe(true);
  });

  it('turns hub errors into a tool error instead of throwing', async () => {
    const browser = new WebDriverSession({ url: withCreds() });
    const result = await callCloudBrowser(browser, 'cloud_browser_click', { selector: '#missing' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no such element');
    expect(text(await callCloudBrowser(browser, 'cloud_browser_navigate', { url: 'javascript:alert(1)' }))).toMatch(/full http/);
  });

  it('reports bad credentials plainly', async () => {
    expect(await testCloudBrowser({ url: base.replace('http://', 'http://user:wrong@') })).toEqual({ ok: false, error: 'The hub refused the credentials.' });
    expect(await testCloudBrowser({ url: withCreds() })).toMatchObject({ ok: true });
  });
});

describe('uploads', () => {
  it('writes a zip that unzip can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    writeFileSync(join(dir, 'a.zip'), storedZip('résumé.pdf', Buffer.from('%PDF hello')));
    expect(execFileSync('unzip', ['-p', join(dir, 'a.zip')]).toString()).toBe('%PDF hello');
  });

  it('uploads only files attached to the task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-'));
    writeFileSync(join(dir, 'resume.pdf'), '%PDF');
    const files = () => [{ path: join(dir, 'resume.pdf'), name: 'resume.pdf' }];
    const browser = new WebDriverSession({ url: withCreds() });
    expect(text(await callCloudBrowser(browser, 'cloud_browser_upload_file', { selector: '#cv', file: 'Resume.PDF' }, undefined, files))).toBe('Attached resume.pdf to #cv.');
    expect(seen.find((call) => call.path === '/session/s1/element/e1/value')?.body).toEqual({ text: '/tmp/up/resume.pdf' });
    const refused = await callCloudBrowser(browser, 'cloud_browser_upload_file', { selector: '#cv', file: '/etc/passwd' }, undefined, files) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Attached: resume.pdf');
    await browser.close();
  });
});

describe('gateway', () => {
  it('offers the cloud browser tools only to runs that have one, asks before acting, and never needs the sandbox', async () => {
    const gateway = new SandboxGateway();
    const asked: GateRequest[] = [];
    const config = {
      agentName: 'Researcher', tools: [] as [], approval: 'risky' as const,
      sandbox: () => Promise.reject(new Error('no sandbox')),
      decide: async (request: GateRequest) => { asked.push(request); return 'accept' as const; },
    };
    const plain = await gateway.open(config);
    const withCloud = await gateway.open({ ...config, cloudBrowser: new WebDriverSession({ url: withCreds() }) });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(withCloud.url)));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('cloud_browser_navigate');
    expect(await plain.toolNames().catch(() => [])).not.toContain('cloud_browser_navigate');

    expect(text(await client.callTool({ name: 'cloud_browser_navigate', arguments: { url: 'https://example.com/' } }))).toContain('Example Domain');
    expect(asked).toHaveLength(0); // looking needs no approval
    await client.callTool({ name: 'cloud_browser_click', arguments: { selector: 'a' } });
    expect(asked.map((request) => request.summary)).toEqual(['Researcher: Cloud browser: click']);

    withCloud.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.some((call) => call.method === 'DELETE')).toBe(true);
    await client.close();
    plain.dispose();
    gateway.close();
  });
});

describe('settings', () => {
  it('keeps the connection in the secret store, shows only the host, and prefers the flow over the agent', async () => {
    const vault = new Map<string, { id: string; label: string; owner?: string; value: string }>();
    let n = 0;
    const secrets = {
      list: () => [...vault.values()].map(({ value: _value, ...meta }) => ({ ...meta, createdAt: '' })),
      put: async (input: { label: string; value: string; owner?: string }) => { const id = `sec_${++n}`; vault.set(id, { id, ...input }); return { id, label: input.label, createdAt: '' }; },
      deleteOwnedBy: async (owner: string) => { let count = 0; for (const [id, item] of vault) if (item.owner === owner) { vault.delete(id); count += 1; } return count; },
    };
    const settings = new CloudBrowserSettings(secrets as never, async (id) => vault.get(id)?.value);
    const agent = 'agent:11111111-1111-4111-8111-111111111111' as const;
    const flow = 'flow:22222222-2222-4222-8222-222222222222' as const;

    expect(await settings.save(agent, { url: 'https://u:p@agent-hub.example/wd/hub' })).toEqual({ configured: true, host: 'agent-hub.example' });
    expect(settings.info(agent)).toEqual({ configured: true, host: 'agent-hub.example' });
    expect([...vault.values()].every((item) => !item.label.includes('p@'))).toBe(true);
    expect(await settings.forRun('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')).toEqual({ url: 'https://u:p@agent-hub.example/wd/hub' });

    await settings.save(flow, { url: 'https://u@flow-hub.example/wd/hub', apiKey: 'k' });
    await settings.save(flow, { url: 'https://u@flow-hub.example/wd/hub', apiKey: 'k2' });
    expect(vault.size).toBe(2); // saving again replaces
    expect(await settings.forRun('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')).toEqual({ url: 'https://u@flow-hub.example/wd/hub', apiKey: 'k2' });

    await settings.remove(flow);
    expect(settings.info(flow)).toEqual({ configured: false });
  });
});
