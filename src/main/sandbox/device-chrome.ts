import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrowserDriver } from './browser-tools';
import { readCookies } from './chrome-cookies';

// Chrome on the user's own Mac, driven over the DevTools protocol. It runs in
// its own profile (Chrome refuses remote control of the everyday profile), so
// the user's own windows are never touched. By default it runs headless; with
// "show window" it opens in the background without taking focus. Sites the
// user signs into in this profile stay signed in for later runs.

type Json = Record<string, unknown>;

const CANDIDATES = [
  '/Applications/Google Chrome.app',
  join(homedir(), 'Applications/Google Chrome.app'),
  '/Applications/Chromium.app',
  '/Applications/Microsoft Edge.app',
  '/Applications/Brave Browser.app',
];
const COMMAND_MS = 60_000;
const LAUNCH_MS = 20_000;
const IDLE_CLOSE_MS = 120_000;
const MAX_TEXT = 60_000;

/** The browser app found on this Mac, if any. */
export function findChrome(candidates: readonly string[] = CANDIDATES): { app: string; binary: string; name: string } | undefined {
  if (process.platform !== 'darwin') return undefined;
  for (const app of candidates) {
    const name = basename(app, '.app');
    const binary = join(app, 'Contents/MacOS', name);
    if (existsSync(binary)) return { app, binary, name };
  }
  return undefined;
}

/** A profile in the user's own Google Chrome. */
export interface ChromeProfile { dir: string; name: string; email?: string; picture: boolean }

export const CHROME_DATA_DIR = join(homedir(), 'Library/Application Support/Google/Chrome');

/** The profiles in the user's Chrome, from its Local State (names and accounts only). */
export function chromeProfiles(dataDir = CHROME_DATA_DIR): ChromeProfile[] {
  const raw = readFileSync(join(dataDir, 'Local State'), 'utf8');
  const cache = (JSON.parse(raw) as { profile?: { info_cache?: Record<string, { name?: string; user_name?: string; gaia_picture_file_name?: string; is_using_default_avatar?: boolean }> } }).profile?.info_cache ?? {};
  return Object.entries(cache)
    .filter(([dir]) => existsSync(join(dataDir, dir)))
    .map(([dir, info]) => ({
      dir,
      name: info.name ?? dir,
      ...(info.user_name !== undefined && info.user_name !== '' ? { email: info.user_name } : {}),
      picture: (info.gaia_picture_file_name ?? '') !== '' && info.is_using_default_avatar !== true,
    }));
}

/** "auto": the profile signed into a Google account with its own picture, else the first one. */
export function pickProfile(profiles: readonly ChromeProfile[], wanted: string | undefined): ChromeProfile | undefined {
  if (wanted !== undefined && wanted !== 'auto' && wanted !== '') return profiles.find((profile) => profile.dir === wanted);
  return profiles.find((profile) => profile.picture) ?? profiles.find((profile) => profile.email !== undefined) ?? profiles[0];
}

// Copied from the user's profile: everything but caches and open tabs/sessions.
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'CacheStorage', 'ScriptCache',
  'Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs', 'Download Service', 'optimization_guide_model_store', 'Safe Browsing Network']);

/** One DevTools WebSocket connection (to the whole browser; pages are reached through flat sessions). */
class Cdp {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      let message: { id?: number; result?: Json; error?: { message?: string } };
      try { message = JSON.parse(String(event.data)) as typeof message; } catch { return; }
      if (message.id === undefined) return;
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) waiting.reject(new Error(message.error.message ?? 'Chrome refused the command.'));
      else waiting.resolve(message.result ?? {});
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const waiting of this.pending.values()) waiting.reject(new Error('Chrome was closed.'));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => { resolve(new Cdp(ws)); }, { once: true });
      ws.addEventListener('error', () => { reject(new Error('Could not connect to Chrome.')); }, { once: true });
    });
  }

  send(method: string, params: Json = {}, sessionId?: string, signal?: AbortSignal): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('Chrome was closed.'));
    const id = this.next++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome did not answer ${method} in time.`)); }, COMMAND_MS);
      const done = (fn: () => void): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
      const onAbort = (): void => { this.pending.delete(id); done(() => { reject(new Error('Stopped.')); }); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: (value) => { done(() => { resolve(value); }); }, reject: (error) => { done(() => { reject(error); }); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) }));
    });
  }

  close(): void { try { this.ws.close(); } catch { /* already closed */ } }
}

export interface DeviceChromeOptions {
  /** The profile folder Conductor's Chrome uses (logins live here). */
  profileDir: string;
  /** Whether to show the window (in the background) instead of running headless. */
  visible: () => boolean;
  /** Override where to look for the browser (tests). */
  candidates?: readonly string[];
  /**
   * Which of the user's own Chrome profiles to start from ("auto", or its folder
   * name). Its logins are copied into Conductor's profile; unset starts empty.
   */
  sourceProfile?: () => string | undefined;
  /** The user's Chrome data folder (tests). */
  chromeDataDir?: string;
  /**
   * Drive the Chrome the user already has open (its everyday profile) instead of a private
   * copy. It must allow remote debugging (chrome://inspect/#remote-debugging); nothing is
   * launched or closed, and agents only work in tabs of their own.
   */
  attach?: boolean;
  /** Reads the Keychain password that decrypts copied cookies (tests). */
  cookiePassword?: () => Promise<string>;
}

export interface DeviceChromeStatus { available: boolean; browser?: string; running: boolean; visible?: boolean; profile?: { name: string; email?: string; copiedAt: string }; profileError?: string }

/** Conductor's own Chrome on this Mac, shared by every run that uses it. */
export class DeviceChrome {
  private conn: Promise<Cdp> | undefined;
  private child: ChildProcess | undefined;
  private headless = true;
  private users = 0;
  private idle: NodeJS.Timeout | undefined;
  private profileError: string | undefined;
  /** Cookies of a fresh copy still to be handed to the Chrome that starts on it. */
  private cookiesPending = false;

  constructor(private readonly opts: DeviceChromeOptions) {}

  private chrome(): { app: string; binary: string; name: string } | undefined { return findChrome(this.opts.candidates); }

  available(): boolean { return this.chrome() !== undefined; }

  status(): DeviceChromeStatus {
    const found = this.chrome();
    const copied = this.copied();
    return {
      available: found !== undefined, ...(found !== undefined ? { browser: found.name } : {}), running: this.conn !== undefined, ...(this.conn !== undefined ? { visible: !this.headless } : {}),
      ...(copied !== undefined ? { profile: { name: copied.name, ...(copied.email !== undefined ? { email: copied.email } : {}), copiedAt: copied.copiedAt } } : {}),
      ...(this.profileError !== undefined ? { profileError: this.profileError } : {}),
    };
  }

  /** The user's Chrome profiles (to choose which one agents start from). */
  profiles(): ChromeProfile[] {
    return chromeProfiles(this.opts.chromeDataDir ?? CHROME_DATA_DIR);
  }

  private markerFile(): string { return join(this.opts.profileDir, 'conductor-source.json'); }

  private copied(): { dir: string; name: string; email?: string; copiedAt: string } | undefined {
    try { return JSON.parse(readFileSync(this.markerFile(), 'utf8')) as { dir: string; name: string; email?: string; copiedAt: string }; } catch { return undefined; }
  }

  /**
   * Copy the chosen profile of the user's Chrome into Conductor's (logins,
   * cookies, saved settings; not caches or open tabs). Done once, and again
   * when the choice changes or the user asks for fresh logins.
   */
  private async syncProfile(force = false): Promise<void> {
    const wanted = this.opts.sourceProfile?.();
    if (wanted === undefined || this.opts.attach === true) return;
    const dataDir = this.opts.chromeDataDir ?? CHROME_DATA_DIR;
    try {
      const source = pickProfile(chromeProfiles(dataDir), wanted);
      if (source === undefined) throw new Error('That Chrome profile no longer exists.');
      if (!force && this.copied()?.dir === source.dir) { this.profileError = undefined; return; }
      const target = join(this.opts.profileDir, 'Default');
      rmSync(target, { recursive: true, force: true });
      mkdirSync(this.opts.profileDir, { recursive: true });
      await cp(join(dataDir, source.dir), target, { recursive: true, filter: (path) => !SKIP.has(basename(path)) && !/^Singleton/.test(basename(path)) });
      writeFileSync(this.markerFile(), JSON.stringify({ dir: source.dir, name: source.name, ...(source.email !== undefined ? { email: source.email } : {}), copiedAt: new Date().toISOString() }));
      this.profileError = undefined;
      this.cookiesPending = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.profileError = code === 'EPERM' || code === 'EACCES'
        ? 'macOS did not let Conductor read your Chrome profile. Allow it in System Settings → Privacy & Security (App Management or Full Disk Access), then try again.'
        : `Your Chrome profile could not be copied: ${error instanceof Error ? error.message : 'unknown error'}`;
      if (force) throw new Error(this.profileError);
    }
  }

  /** Copy the user's profile again (after they signed into more sites in their own Chrome). */
  async refreshProfile(): Promise<DeviceChromeStatus> {
    if (this.users > 0) throw new Error('An agent is using Chrome right now. Try again when it finishes.');
    await this.shutdown();
    await this.syncProfile(true);
    return this.status();
  }

  /** A new tab for one run. Nothing starts until its first call. */
  session(): BrowserDriver { return new ChromeTab(this); }

  /** The DevTools address of a Chrome already running on the profile, if it answers. */
  private async running(): Promise<string | undefined> {
    const file = join(this.opts.attach === true ? (this.opts.chromeDataDir ?? CHROME_DATA_DIR) : this.opts.profileDir, 'DevToolsActivePort');
    if (!existsSync(file)) return undefined;
    const [port, path] = readFileSync(file, 'utf8').split('\n');
    if (port === undefined || path === undefined || !/^\d+$/.test(port.trim())) return undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${port.trim()}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return undefined;
      return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    } catch { return undefined; }
  }

  private async launch(headless: boolean): Promise<string> {
    const found = this.chrome();
    if (found === undefined) throw new Error('Google Chrome is not installed on this Mac.');
    if (this.opts.attach === true) throw new Error('Your current Chrome is not open for agents. Open it, go to chrome://inspect/#remote-debugging and turn on “Allow remote debugging for this browser instance”.');
    mkdirSync(this.opts.profileDir, { recursive: true });
    await this.syncProfile();
    rmSync(join(this.opts.profileDir, 'DevToolsActivePort'), { force: true });
    const args = [
      `--user-data-dir=${this.opts.profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      // A copy of the user's profile must not sync agent browsing back into their Google account.
      '--disable-sync', '--hide-crash-restore-bubble',
      // Keep pages working while the window is hidden behind the user's own.
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      // Shown: no window at start, so Chrome does not take focus; each run opens its own window in the background.
      '--window-size=1366,900', ...(headless ? ['--headless=new', 'about:blank'] : ['--no-startup-window']),
    ];
    if (headless) {
      this.child = spawn(found.binary, args, { stdio: 'ignore' });
      this.child.once('exit', () => { this.child = undefined; });
    } else {
      // `open -g` starts the app without bringing it to the front.
      await new Promise<void>((resolve, reject) => { execFile('open', ['-g', '-n', '-a', found.app, '--args', ...args], (error) => { if (error) reject(error); else resolve(); }); });
    }
    const until = Date.now() + LAUNCH_MS;
    while (Date.now() < until) {
      const url = await this.running();
      if (url !== undefined) return url;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${found.name} did not start.`);
  }

  private connect(): Promise<Cdp> {
    const current = this.conn;
    if (current !== undefined) {
      return current.then((cdp) => {
        if (!cdp.closed) return cdp;
        if (this.conn === current) this.conn = undefined;
        return this.connect();
      });
    }
    const wanted = !this.opts.visible();
    const next = (async () => {
      let url = await this.running();
      if (url !== undefined) {
        const cdp = await Cdp.connect(url);
        if (this.opts.attach === true) { this.headless = false; return cdp; }
        const version = await cdp.send('Browser.getVersion');
        const headless = /Headless/i.test(String(version['userAgent'] ?? ''));
        // A hidden Chrome left from before, but the user now wants to see it: restart it shown.
        if (headless === wanted || this.users > 0) { this.headless = headless; return cdp; }
        await cdp.send('Browser.close').catch(() => undefined);
        cdp.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      url = await this.launch(wanted);
      this.headless = wanted;
      return this.restoreCookies(await Cdp.connect(url));
    })();
    this.conn = next;
    next.catch(() => { if (this.conn === next) this.conn = undefined; });
    return next;
  }

  /**
   * A fresh copy of the profile has cookies the new Chrome cannot read, so it drops them. Decrypt
   * them with the Keychain key and set them over DevTools. Best effort: if the Keychain is
   * refused the agents' Chrome simply starts signed out.
   */
  private async restoreCookies(cdp: Cdp): Promise<Cdp> {
    if (!this.cookiesPending) return cdp;
    this.cookiesPending = false;
    try {
      const cookies = await readCookies(join(this.opts.profileDir, 'Default'), this.opts.cookiePassword);
      for (let at = 0; at < cookies.length; at += 200) await cdp.send('Storage.setCookies', { cookies: cookies.slice(at, at + 200) }).catch(() => undefined);
    } catch (error) {
      this.profileError = `Your logins could not be carried over: ${error instanceof Error ? error.message : 'unknown error'}. Allow Conductor to use “Chrome Safe Storage” in the Keychain, then press Refresh logins.`;
    }
    return cdp;
  }

  /** Used by a tab: the browser connection, counted so an idle hidden Chrome can be closed. */
  async acquire(): Promise<Cdp> {
    if (this.idle !== undefined) { clearTimeout(this.idle); this.idle = undefined; }
    const cdp = await this.connect();
    this.users += 1;
    return cdp;
  }

  release(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0 || !this.headless) return;
    this.idle = setTimeout(() => { this.idle = undefined; if (this.users === 0) void this.shutdown(); }, IDLE_CLOSE_MS);
    this.idle.unref();
  }

  /**
   * Show Conductor's Chrome so the user can sign in to sites (or watch). A
   * hidden one is restarted shown, unless an agent is using it right now.
   */
  async show(url = 'about:blank'): Promise<void> {
    const found = this.chrome();
    if (found === undefined) throw new Error('Google Chrome is not installed on this Mac.');
    if (this.conn !== undefined || (await this.running()) !== undefined) {
      const cdp = await this.connect();
      if (this.headless) {
        if (this.users > 0) throw new Error('An agent is using the hidden Chrome right now. Try again when it finishes.');
        await this.shutdown();
      } else {
        const { targetId } = await cdp.send('Target.createTarget', { url });
        await cdp.send('Target.activateTarget', { targetId });
        execFile('open', ['-a', found.app]);
        return;
      }
    }
    const launched = await this.launch(false);
    this.headless = false;
    const cdp = Cdp.connect(launched).then((connected) => this.restoreCookies(connected));
    this.conn = cdp;
    await (await cdp).send('Target.createTarget', { url });
    execFile('open', ['-a', found.app]);
  }

  /** Close Conductor's Chrome (never the user's own). */
  async shutdown(): Promise<void> {
    if (this.idle !== undefined) { clearTimeout(this.idle); this.idle = undefined; }
    const pending = this.conn;
    this.conn = undefined;
    const cdp = await pending?.catch(() => undefined);
    // The user's own Chrome is only disconnected from, never closed.
    if (cdp !== undefined && !cdp.closed) { if (this.opts.attach !== true) await cdp.send('Browser.close').catch(() => undefined); cdp.close(); }
    this.child?.kill();
    this.child = undefined;
  }
}

/** Finds an element by CSS selector, or by XPath when it starts with / or (. */
const FIND = '(s)=>s.startsWith("/")||s.startsWith("(")?document.evaluate(s,document,null,9,null).singleNodeValue:document.querySelector(s)';
const find = (selector: string): string => `(${FIND})(${JSON.stringify(selector)})`;

/** One run's tab (in a window of its own, opened in the background). */
class ChromeTab implements BrowserDriver {
  private tab: Promise<{ cdp: Cdp; sessionId: string; targetId: string }> | undefined;

  constructor(private readonly chrome: DeviceChrome) {}

  private async page(signal?: AbortSignal): Promise<{ cdp: Cdp; sessionId: string; targetId: string }> {
    const current = this.tab;
    if (current !== undefined) {
      const open = await current.catch(() => undefined);
      if (open !== undefined && !open.cdp.closed) return open;
      if (open !== undefined && this.tab === current) { this.tab = undefined; this.chrome.release(); }
    }
    this.tab ??= (async () => {
      const cdp = await this.chrome.acquire();
      try {
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true }, undefined, signal) as { targetId: string };
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, signal) as { sessionId: string };
        await cdp.send('Page.enable', {}, sessionId);
        // Pages behave as if focused even though the window stays behind the user's.
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => undefined);
        return { cdp, sessionId, targetId };
      } catch (error) {
        this.chrome.release();
        throw error;
      }
    })();
    this.tab.catch(() => { this.tab = undefined; });
    return this.tab;
  }

  private async send(method: string, params: Json, signal?: AbortSignal): Promise<Json> {
    const { cdp, sessionId } = await this.page(signal);
    return cdp.send(method, params, sessionId, signal);
  }

  private async eval(expression: string, signal?: AbortSignal): Promise<unknown> {
    const out = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, signal) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (out.exceptionDetails !== undefined) throw new Error((out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'The script failed.').split('\n')[0]!.replace(/^Error: /, ''));
    return out.result?.value;
  }

  /** Wait for the page to finish loading (after a navigation, click or Enter). */
  private async settle(signal?: AbortSignal, ms = 30_000, first = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, first));
    const until = Date.now() + ms;
    while (Date.now() < until && signal?.aborted !== true) {
      const state = await this.eval('document.readyState', signal).catch(() => 'loading');
      if (state === 'complete') return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async navigate(url: string, signal?: AbortSignal): Promise<string> {
    const out = await this.send('Page.navigate', { url }, signal) as { errorText?: string };
    if (out.errorText !== undefined && out.errorText !== '') throw new Error(`Could not open ${url}: ${out.errorText}`);
    await this.settle(signal);
    return this.where(signal);
  }

  async where(signal?: AbortSignal): Promise<string> {
    const at = await this.eval('({ url: location.href, title: document.title })', signal) as { url?: string; title?: string } | undefined;
    return `Now at ${at?.url ?? ''} — “${at?.title ?? ''}”.`;
  }

  async screenshot(signal?: AbortSignal): Promise<string> {
    const out = await this.send('Page.captureScreenshot', { format: 'png' }, signal) as { data?: string };
    if (typeof out.data !== 'string') throw new Error('Chrome returned no screenshot.');
    return out.data;
  }

  async text(selector: string | undefined, signal?: AbortSignal): Promise<string> {
    const value = selector !== undefined && selector !== ''
      ? await this.eval(`(() => { const el = ${find(selector)}; if (!el) throw new Error(${JSON.stringify(`No element matches ${selector}.`)}); return el.innerText ?? el.textContent; })()`, signal)
      : await this.eval('document.body ? document.body.innerText : document.documentElement.innerText', signal);
    const text = String(value ?? '');
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)` : text;
  }

  async click(selector: string, signal?: AbortSignal): Promise<string> {
    const box = await this.eval(`(() => { const el = ${find(selector)}; if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`, signal) as { x: number; y: number; w: number; h: number } | null;
    if (box === null) throw new Error(`No element matches ${selector}.`);
    if (box.w === 0 && box.h === 0) {
      await this.eval(`${find(selector)}.click()`, signal);
    } else {
      // Real mouse events, so pages that ignore scripted clicks still react.
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, signal);
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, signal);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, signal);
    }
    await this.settle(signal, 10_000, 400);
    return `Clicked ${selector}. ${await this.where(signal)}`;
  }

  async type(selector: string, text: string, opts: { clear?: boolean; submit?: boolean }, signal?: AbortSignal): Promise<string> {
    const found = await this.eval(`(() => { const el = ${find(selector)}; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus();
      if (${opts.clear === true}) {
        if ('value' in el) { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (set) set.call(el, ''); else el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
        else if (el.isContentEditable) { document.execCommand('selectAll'); document.execCommand('delete'); }
      } return true; })()`, signal);
    if (found !== true) throw new Error(`No element matches ${selector}.`);
    await this.send('Input.insertText', { text }, signal);
    if (opts.submit === true) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' }, signal);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, signal);
      await this.settle(signal, 15_000, 500);
      return `Typed into ${selector}. ${await this.where(signal)}`;
    }
    return `Typed into ${selector}.`;
  }

  execute(script: string, _args: unknown[] = [], signal?: AbortSignal): Promise<unknown> {
    return this.eval(`(async () => { ${script}\n })()`, signal);
  }

  async back(signal?: AbortSignal): Promise<string> {
    await this.eval('history.back()', signal);
    await this.settle(signal, 15_000, 500);
    return this.where(signal);
  }

  /** Chrome runs on this Mac, so the attached file is handed over by its path. */
  async upload(selector: string, file: { path: string; name: string }, signal?: AbortSignal): Promise<string> {
    const out = await this.send('Runtime.evaluate', { expression: find(selector) }, signal) as { result?: { objectId?: string } };
    const objectId = out.result?.objectId;
    if (objectId === undefined) throw new Error(`No element matches ${selector}.`);
    await this.send('DOM.setFileInputFiles', { files: [file.path], objectId }, signal);
    return `Attached ${file.name} to ${selector}.`;
  }

  /** Close this run's tab. Safe to call any time. */
  async close(): Promise<void> {
    const pending = this.tab;
    this.tab = undefined;
    if (pending === undefined) return;
    const open = await pending.catch(() => undefined);
    if (open === undefined) return;
    if (!open.cdp.closed) await open.cdp.send('Target.closeTarget', { targetId: open.targetId }).catch(() => undefined);
    this.chrome.release();
  }
}
