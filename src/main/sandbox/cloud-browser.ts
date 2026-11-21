import { readFile, stat } from 'node:fs/promises';
import type { SecretStore } from '../secrets/secret-store';

// A remote headless browser (any Selenium / W3C WebDriver hub, such as
// Catalyst SmartBrowz) that an agent or a flow can be given in addition to
// its sandbox. Conductor speaks the WebDriver protocol itself, so the hub's
// address and key stay in the Keychain on this Mac: the agent CLI only sees
// the cloud_browser_* tools, never the connection string.

type Json = Record<string, unknown>;

export interface CloudBrowserConfig {
  /** The hub URL, e.g. https://user:key@host/wd/hub. */
  url: string;
  /** Optional key; used as the password for the user named in the URL. */
  apiKey?: string;
}

/** Who a cloud browser belongs to: one agent, or one flow (a flow's wins for its steps). */
export type CloudBrowserScope = `agent:${string}` | `flow:${string}`;

export interface CloudBrowserInfo { configured: boolean; host?: string }

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const REQUEST_MS = 90_000;
const MAX_TEXT = 60_000;

/** The hub's base URL and the headers that authorise it, from what the user typed. */
export function connection(config: CloudBrowserConfig): { base: string; host: string; headers: Record<string, string> } {
  let parsed: URL;
  try { parsed = new URL(config.url.trim()); } catch { throw new Error('The WebDriver URL is not a valid URL.'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('The WebDriver URL must start with https:// or http://.');
  const user = decodeURIComponent(parsed.username);
  const key = config.apiKey?.trim() ?? '';
  const password = key !== '' ? key : decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';
  // WebDriver hubs reject a plain application/json content type.
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (user !== '' || password !== '') headers['authorization'] = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  return { base: parsed.toString().replace(/\/+$/, ''), host: parsed.host, headers };
}

/** One browser session on the hub, opened on first use and closed when the run ends. */
export class WebDriverSession {
  private session: Promise<string> | undefined;
  private readonly conn: ReturnType<typeof connection>;

  constructor(config: CloudBrowserConfig) { this.conn = connection(config); }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Json, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_MS);
    const response = await fetch(`${this.conn.base}${path}`, {
      method,
      headers: this.conn.headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let parsed: { value?: unknown } | undefined;
    try { parsed = JSON.parse(text) as { value?: unknown }; } catch { /* not JSON */ }
    if (!response.ok) {
      const value = parsed?.value as { message?: unknown; error?: unknown } | undefined;
      const reason = typeof value?.message === 'string' ? value.message.split('\n')[0] : typeof value?.error === 'string' ? value.error : text.slice(0, 200);
      throw new Error(response.status === 401 || response.status === 403 ? 'The hub refused the credentials.' : `HTTP ${response.status}: ${reason}`);
    }
    return parsed?.value;
  }

  private id(signal?: AbortSignal): Promise<string> {
    this.session ??= (async () => {
      const value = await this.request('POST', '/session', {
        capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1366,900'] } } },
      }, signal) as { sessionId?: unknown } | undefined;
      if (typeof value?.sessionId !== 'string') throw new Error('The hub did not start a browser.');
      return value.sessionId;
    })().catch((error: unknown) => { this.session = undefined; throw error; });
    return this.session;
  }

  private async on(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Json, signal?: AbortSignal): Promise<unknown> {
    const id = await this.id(signal);
    return this.request(method, `/session/${id}${path}`, body, signal);
  }

  private async element(selector: string, signal?: AbortSignal): Promise<string> {
    const using = selector.startsWith('/') || selector.startsWith('(') ? 'xpath' : 'css selector';
    const value = await this.on('POST', '/element', { using, value: selector }, signal) as Json | undefined;
    const ref = value?.[ELEMENT_KEY];
    if (typeof ref !== 'string') throw new Error(`No element matches ${selector}.`);
    return ref;
  }

  async navigate(url: string, signal?: AbortSignal): Promise<string> {
    await this.on('POST', '/url', { url }, signal);
    return this.where(signal);
  }

  async where(signal?: AbortSignal): Promise<string> {
    const [title, url] = await Promise.all([this.on('GET', '/title', undefined, signal), this.on('GET', '/url', undefined, signal)]);
    return `Now at ${String(url)} — “${String(title)}”.`;
  }

  async screenshot(signal?: AbortSignal): Promise<string> {
    const value = await this.on('GET', '/screenshot', undefined, signal);
    if (typeof value !== 'string') throw new Error('The hub returned no screenshot.');
    return value;
  }

  async text(selector: string | undefined, signal?: AbortSignal): Promise<string> {
    const value = selector !== undefined && selector !== ''
      ? await this.on('GET', `/element/${await this.element(selector, signal)}/text`, undefined, signal)
      : await this.execute('return document.body ? document.body.innerText : document.documentElement.innerText;', [], signal);
    const text = String(value ?? '');
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)` : text;
  }

  async click(selector: string, signal?: AbortSignal): Promise<string> {
    await this.on('POST', `/element/${await this.element(selector, signal)}/click`, {}, signal);
    return `Clicked ${selector}. ${await this.where(signal)}`;
  }

  async type(selector: string, text: string, opts: { clear?: boolean; submit?: boolean }, signal?: AbortSignal): Promise<string> {
    const ref = await this.element(selector, signal);
    if (opts.clear === true) await this.on('POST', `/element/${ref}/clear`, {}, signal);
    //  is WebDriver's Enter key.
    await this.on('POST', `/element/${ref}/value`, { text: opts.submit === true ? `${text}` : text }, signal);
    return `Typed into ${selector}.${opts.submit === true ? ` ${await this.where(signal)}` : ''}`;
  }

  execute(script: string, args: unknown[] = [], signal?: AbortSignal): Promise<unknown> {
    return this.on('POST', '/execute/sync', { script, args }, signal);
  }

  async back(signal?: AbortSignal): Promise<string> {
    await this.on('POST', '/back', {}, signal);
    return this.where(signal);
  }

  /**
   * Put a file from this Mac into an <input type=file> on the page. The file
   * is first sent to the hub (Selenium's /se/file), which returns the path the
   * remote browser can read it from.
   */
  async upload(selector: string, file: { path: string; name: string }, signal?: AbortSignal): Promise<string> {
    if ((await stat(file.path)).size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.`);
    const zip = storedZip(file.name, await readFile(file.path));
    const remote = await this.on('POST', '/se/file', { file: zip.toString('base64') }, signal);
    if (typeof remote !== 'string' || remote === '') throw new Error('The hub did not accept the file.');
    await this.on('POST', `/element/${await this.element(selector, signal)}/value`, { text: remote }, signal);
    return `Attached ${file.name} to ${selector}.`;
  }

  /** End the hub session (frees the remote browser). Safe to call any time. */
  async close(): Promise<void> {
    const pending = this.session;
    this.session = undefined;
    if (pending === undefined) return;
    const id = await pending.catch(() => undefined);
    if (id !== undefined) await this.request('DELETE', `/session/${id}`).catch(() => undefined);
  }
}

const MAX_UPLOAD_BYTES = 25_000_000;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip holding one uncompressed file: what Selenium's upload endpoint takes. */
export function storedZip(name: string, data: Buffer): Buffer {
  const fileName = Buffer.from(name.replace(/[/\\]/g, '_'), 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(0, 30); central.writeUInt32LE(0, 34); central.writeUInt32LE(0, 38); central.writeUInt32LE(0, 42);
  const centralOffset = local.length + fileName.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

// ---- the tools an agent sees -------------------------------------------------

export const CLOUD_BROWSER_TOOLS = [
  { name: 'cloud_browser_navigate', description: 'Open a URL in your cloud browser (a remote headless Chrome, separate from the sandbox browser). Use it when you were told to use the cloud browser, or the sandbox has no browser.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'cloud_browser_get_text', description: 'Read the visible text of the cloud browser page, or of one element (CSS selector or XPath).', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, additionalProperties: false } },
  { name: 'cloud_browser_screenshot', description: 'Take a screenshot of the cloud browser page.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cloud_browser_click', description: 'Click an element in the cloud browser, by CSS selector or XPath.', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'], additionalProperties: false } },
  { name: 'cloud_browser_type', description: 'Type text into a field in the cloud browser (CSS selector or XPath). Set submit to press Enter afterwards, clear to empty the field first.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } }, required: ['selector', 'text'], additionalProperties: false } },
  { name: 'cloud_browser_execute_script', description: 'Run JavaScript in the cloud browser page and get its return value (use `return …`).', inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'], additionalProperties: false } },
  { name: 'cloud_browser_upload_file', description: 'Attach one of the files the user attached to this task to a file field (<input type=file>) in the cloud browser, e.g. a resume on an application form. Give the field (CSS selector or XPath) and the file name as the user attached it.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, file: { type: 'string', description: 'The attached file\'s name.' } }, required: ['selector', 'file'], additionalProperties: false } },
  { name: 'cloud_browser_back', description: 'Go back one page in the cloud browser.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cloud_browser_close', description: 'Close the cloud browser when you are done with it; the next cloud_browser call opens a fresh one.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
] as const;

export const CLOUD_BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(CLOUD_BROWSER_TOOLS.map((tool) => tool.name));

const str = (args: Json, key: string): string => (typeof args[key] === 'string' ? args[key] : '');

/** Run one cloud_browser_* call; resolves to MCP tool-result content. */
export async function callCloudBrowser(browser: WebDriverSession, name: string, args: Json, signal?: AbortSignal, files: () => Array<{ path: string; name: string }> = () => []): Promise<Json> {
  const text = (value: string): Json => ({ content: [{ type: 'text', text: value }] });
  try {
    switch (name) {
      case 'cloud_browser_navigate': {
        const url = str(args, 'url').trim();
        if (!/^https?:\/\//i.test(url)) return { ...text('Give a full http(s) URL.'), isError: true };
        return text(await browser.navigate(url, signal));
      }
      case 'cloud_browser_get_text': return text(await browser.text(str(args, 'selector').trim() || undefined, signal));
      case 'cloud_browser_screenshot': return { content: [{ type: 'image', data: await browser.screenshot(signal), mimeType: 'image/png' }] };
      case 'cloud_browser_click': return text(await browser.click(str(args, 'selector'), signal));
      case 'cloud_browser_type': return text(await browser.type(str(args, 'selector'), str(args, 'text'), { clear: args['clear'] === true, submit: args['submit'] === true }, signal));
      case 'cloud_browser_execute_script': {
        const value = await browser.execute(str(args, 'script'), [], signal);
        const out = typeof value === 'string' ? value : JSON.stringify(value ?? null);
        return text(out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}…` : out);
      }
      case 'cloud_browser_upload_file': {
        // Only files the user attached to this task can be sent, never any other file on the Mac.
        const available = files();
        const wanted = str(args, 'file').trim();
        const file = available.find((item) => item.name === wanted) ?? available.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
        if (file === undefined) return { ...text(available.length === 0 ? 'No files are attached to this task.' : `No attached file is called "${wanted}". Attached: ${available.map((item) => item.name).join(', ')}.`), isError: true };
        return text(await browser.upload(str(args, 'selector'), file, signal));
      }
      case 'cloud_browser_back': return text(await browser.back(signal));
      case 'cloud_browser_close': await browser.close(); return text('Closed the cloud browser.');
      default: return { ...text(`Unknown tool ${name}.`), isError: true };
    }
  } catch (error) {
    return { ...text(`The cloud browser could not do that: ${error instanceof Error ? error.message : 'unknown error'}`), isError: true };
  }
}

// ---- settings, per agent and per flow ------------------------------------------

/** The Keychain owner tag for a scope's connection. */
const owner = (scope: CloudBrowserScope): string => `cloud-browser:${scope}`;

export class CloudBrowserSettings {
  constructor(private readonly secrets: SecretStore, private readonly resolve: (secretId: string) => Promise<string | undefined>) {}

  info(scope: CloudBrowserScope): CloudBrowserInfo {
    const secret = this.secrets.list().find((item) => item.owner === owner(scope));
    if (secret === undefined) return { configured: false };
    // The label carries the host (never the credentials), so the UI can show it without a Keychain read.
    return { configured: true, host: secret.label.replace(/^Cloud browser · /, '') };
  }

  async save(scope: CloudBrowserScope, config: CloudBrowserConfig): Promise<CloudBrowserInfo> {
    const { host } = connection(config);
    const value = JSON.stringify({ url: config.url.trim(), ...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}) });
    await this.secrets.deleteOwnedBy(owner(scope));
    await this.secrets.put({ label: `Cloud browser · ${host}`, value, owner: owner(scope) });
    return { configured: true, host };
  }

  async remove(scope: CloudBrowserScope): Promise<void> {
    await this.secrets.deleteOwnedBy(owner(scope));
  }

  async config(scope: CloudBrowserScope): Promise<CloudBrowserConfig | undefined> {
    const secret = this.secrets.list().find((item) => item.owner === owner(scope));
    if (secret === undefined) return undefined;
    const raw = await this.resolve(secret.id).catch(() => undefined);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as { url?: unknown; apiKey?: unknown };
      return typeof parsed.url === 'string' ? { url: parsed.url, ...(typeof parsed.apiKey === 'string' ? { apiKey: parsed.apiKey } : {}) } : undefined;
    } catch { return undefined; }
  }

  /** The connection a run uses: its flow's when it is a flow step and the flow has one, else its agent's. */
  async forRun(agentId: string, flowId: string | undefined): Promise<CloudBrowserConfig | undefined> {
    return (flowId !== undefined ? await this.config(`flow:${flowId}`) : undefined) ?? this.config(`agent:${agentId}`);
  }
}

/** Open a session, load a blank page and close it: proves the URL and key work. */
export async function testCloudBrowser(config: CloudBrowserConfig): Promise<{ ok: boolean; browser?: string; error?: string }> {
  const browser = new WebDriverSession(config);
  try {
    await browser.navigate('about:blank');
    const version = await browser.execute('return navigator.userAgent;').catch(() => undefined);
    const match = typeof version === 'string' ? /Chrome\/[\d.]+/.exec(version)?.[0] : undefined;
    return { ok: true, ...(match !== undefined ? { browser: match.replace('/', ' ') } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
  } finally {
    await browser.close();
  }
}
