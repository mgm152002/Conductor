import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { IpcResult } from '@shared/ipc-contract';
import type { Task } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { buildTimeline, latestActivity } from '../../renderer/lib/timeline';
import { isWorkingState, threadTitle } from '../../renderer/lib/thread-status';
import { groupThreads, threadKey } from '../../renderer/lib/threads';
import { classifyThreadTier, groupThreadsByTier, type ThreadTierPref } from '../../renderer/lib/thread-tiers';
import type { ThreadTierStore } from './thread-tier-store';
import { mobilePage } from './mobile-page';

// The web server behind "Control on phone". It listens on loopback only; the
// ngrok tunnel is the only way in from outside. Nothing is reachable without
// a session token, and a token is only issued for a one-time pairing code
// that the QR code carries in the link's #fragment (never sent to a server
// log). Phones can call a short allowlist of actions: chat, watch and steer
// work, answer approvals, look at usage. Settings, secrets, MCP servers,
// deletion and the like are not reachable from here.

export interface SandboxEndpointLike { baseUrl: string; apiKey: string }

/** Actions a signed-in phone may call. */
export const PHONE_CHANNELS: ReadonlySet<string> = new Set([
  'task.list', 'task.get', 'task.details', 'task.thread', 'task.create', 'task.enqueue', 'task.cancel', 'task.queueList', 'task.queueCancel',
  'approval.list', 'approval.resolve', 'question.list', 'question.answer',
  'usage.summary', 'workspace.list', 'registry.listAdapters', 'agents.list', 'agents.models',
  'agents.sandbox.list', 'agents.sandbox.threads', 'agents.workspace',
  'agents.group.list', 'agents.group.messages', 'agents.group.send',
  'chat.list', 'chat.get', 'chat.send', 'chat.cancel',
]);

const PAIR_TTL_MS = 10 * 60_000;
const SESSION_IDLE_MS = 24 * 3_600_000;
const WATCH_MS = 30 * 60_000;
const MAX_DEVICES = 5;
const MAX_BODY = 64 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;
const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 8;

export interface PhoneServerDeps {
  invoke(channel: string, payload: unknown): Promise<IpcResult<unknown>>;
  /** Where a sandbox's live desktop is, while it runs. */
  sandboxEndpoint?: (agentId: string) => SandboxEndpointLike | undefined;
  tiers?: ThreadTierStore;
  now?: () => number;
}

interface Session { hash: string; lastSeen: number; label: string }
interface Watch { agentId: string; session: string; expires: number }
interface Turn { id: string; state: string; working: boolean; activity?: string; messages: Array<{ role: 'user' | 'agent' | 'error'; text: string; at: string }> }

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const safeEqual = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));

export class PhoneServer {
  private server: Server | undefined;
  private pairCode: { code: string; expires: number } | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly watches = new Map<string, Watch>();
  private failures: number[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: PhoneServerDeps) { this.now = deps.now ?? Date.now; }

  get devices(): number { this.prune(); return this.sessions.size; }

  async listen(port = 0): Promise<number> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => this.send(res, 500, { error: 'Something went wrong.' })); });
    this.server.on('upgrade', (req, socket, head) => { this.upgrade(req, socket, head); });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', resolve); });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    this.watches.clear();
    this.pairCode = undefined;
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }

  /** A fresh single-use code; the previous one stops working. */
  newPairing(): { code: string; expiresAt: number } {
    const code = randomBytes(18).toString('hex');
    const expiresAt = this.now() + PAIR_TTL_MS;
    this.pairCode = { code, expires: expiresAt };
    return { code, expiresAt };
  }

  /** Sign every phone out. */
  revokeAll(): void { this.sessions.clear(); this.watches.clear(); }

  // ---- requests -------------------------------------------------------------

  private prune(): void {
    const cutoff = this.now() - SESSION_IDLE_MS;
    for (const [id, session] of this.sessions) if (session.lastSeen < cutoff) this.sessions.delete(id);
  }

  private limited(): boolean {
    const cutoff = this.now() - FAIL_WINDOW_MS;
    this.failures = this.failures.filter((at) => at > cutoff);
    return this.failures.length >= FAIL_LIMIT;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    res.end(JSON.stringify(body));
  }

  private body(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }

  private authorised(req: IncomingMessage): Session | undefined {
    this.prune();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token === '') return undefined;
    const session = this.sessions.get(sha(token));
    if (session === undefined) return undefined;
    session.lastSeen = this.now();
    return session;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      });
      res.end(mobilePage(nonce));
      return;
    }
    if (url.pathname.startsWith('/w/')) { this.proxy(req, res, url); return; }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) { this.send(res, 404, { error: 'Not found.' }); return; }
    // Same-origin calls only: a page on another site can't drive the API.
    const origin = req.headers.origin;
    if (origin !== undefined && new URL(origin).host !== req.headers.host) { this.send(res, 403, { error: 'Not allowed.' }); return; }
    const upload = url.pathname === '/api/upload';
    if (!upload && !(req.headers['content-type'] ?? '').startsWith('application/json')) { this.send(res, 415, { error: 'Send JSON.' }); return; }

    if (url.pathname === '/api/pair') {
      if (this.limited()) { this.send(res, 429, { error: 'Too many attempts. Wait a minute and scan the code again.' }); return; }
      let code = '';
      try { const body = await this.body(req) as { code?: unknown } | null; code = typeof body?.code === 'string' ? body.code : ''; } catch { this.send(res, 400, { error: 'Bad request.' }); return; }
      const pairing = this.pairCode;
      if (pairing === undefined || pairing.expires < this.now() || code === '' || !safeEqual(code, pairing.code)) {
        this.failures.push(this.now());
        this.send(res, 401, { error: 'This link has expired. Open Control on phone on your Mac and scan the new code.' });
        return;
      }
      this.pairCode = undefined; // single use
      this.prune();
      if (this.sessions.size >= MAX_DEVICES) {
        const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if (oldest !== undefined) this.sessions.delete(oldest[0]);
      }
      const token = randomBytes(32).toString('hex');
      this.sessions.set(sha(token), { hash: sha(token), lastSeen: this.now(), label: (req.headers['user-agent'] ?? 'Phone').slice(0, 80) });
      this.send(res, 200, { token });
      return;
    }

    if (this.limited()) { this.send(res, 429, { error: 'Too many attempts.' }); return; }
    if (this.authorised(req) === undefined) { this.failures.push(this.now()); this.send(res, 401, { error: 'Signed out. Scan the QR code again.' }); return; }
    if (upload) { await this.upload(req, res, url); return; }
    let body: unknown;
    try { body = await this.body(req); } catch { this.send(res, 400, { error: 'Bad request.' }); return; }

    switch (url.pathname) {
      case '/api/rpc': {
        const call = body as { channel?: unknown; payload?: unknown } | null;
        const channel = typeof call?.channel === 'string' ? call.channel : '';
        if (!PHONE_CHANNELS.has(channel)) { this.send(res, 403, { error: 'That isn’t available from the phone.' }); return; }
        let payload = call?.payload;
        // A phone can approve once, never grant a standing approval.
        if (channel === 'approval.resolve' && payload !== null && typeof payload === 'object') { const { remember: _remember, ...rest } = payload as Record<string, unknown>; payload = rest; }
        const result = await this.deps.invoke(channel, payload === null ? undefined : payload);
        this.send(res, 200, result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error.message });
        return;
      }
      case '/api/thread': {
        const threadId = (body as { threadId?: unknown } | null)?.threadId;
        if (typeof threadId !== 'string') { this.send(res, 400, { error: 'Bad request.' }); return; }
        this.send(res, 200, { ok: true, value: await this.threadView(threadId) });
        return;
      }
      case '/api/task': {
        const id = (body as { id?: unknown } | null)?.id;
        if (typeof id !== 'string') { this.send(res, 400, { error: 'Bad request.' }); return; }
        const task = await this.call<Task>('task.get', { id });
        this.send(res, 200, { ok: true, value: task === undefined ? null : await this.turnView(task) });
        return;
      }
      case '/api/work':
        this.send(res, 200, { ok: true, value: await this.work(typeof (body as { workspaceId?: unknown } | null)?.workspaceId === 'string' ? (body as { workspaceId: string }).workspaceId : undefined) });
        return;
      case '/api/tier': {
        const call = body as { key?: unknown; action?: unknown; until?: unknown } | null;
        const result = await this.tier(typeof call?.key === 'string' ? call.key : '', call?.action, typeof call?.until === 'string' ? call.until : undefined);
        this.send(res, result === true ? 200 : 400, result === true ? { ok: true, value: true } : { error: result });
        return;
      }
      case '/api/watch': {
        const agentId = (body as { agentId?: unknown } | null)?.agentId;
        const endpoint = typeof agentId === 'string' ? this.deps.sandboxEndpoint?.(agentId) : undefined;
        if (typeof agentId !== 'string' || endpoint === undefined) { this.send(res, 409, { error: 'That agent’s sandbox isn’t running right now. It starts when the agent begins a task.' }); return; }
        const token = randomBytes(24).toString('hex');
        this.watches.set(token, { agentId, session: sha((req.headers.authorization ?? '').slice(7)), expires: this.now() + WATCH_MS });
        const path = `w/${token}/websockify`;
        this.send(res, 200, { ok: true, value: { src: `/w/${token}/vnc/index.html?autoconnect=true&resize=scale&reconnect=true&path=${encodeURIComponent(path)}` } });
        return;
      }
      default:
        this.send(res, 404, { error: 'Not found.' });
    }
  }

  // ---- uploads ---------------------------------------------------------------

  /** A photo or file from the phone, stored like a desktop attachment. */
  private async upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const name = (url.searchParams.get('name') ?? 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
    const type = (url.searchParams.get('type') ?? 'application/octet-stream').slice(0, 120);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_UPLOAD) { reject(new Error('too large')); req.destroy(); return; } chunks.push(chunk); });
        req.on('end', () => { resolve(); });
        req.on('error', reject);
      });
    } catch { this.send(res, 413, { error: 'That file is over the 25 MB limit.' }); return; }
    if (size === 0) { this.send(res, 400, { error: 'The file is empty.' }); return; }
    const result = await this.deps.invoke('attachment.ingestBytes', { name, mimeType: type, bytes: new Uint8Array(Buffer.concat(chunks)) });
    this.send(res, 200, result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error.message });
  }

  // ---- the work list -----------------------------------------------------------

  private async call<T>(channel: string, payload?: unknown): Promise<T | undefined> {
    const result = await this.deps.invoke(channel, payload);
    return result.ok ? result.value as T : undefined;
  }

  /**
   * Recent tasks across projects, plus every agent chat: those live in a hidden
   * workspace and in whichever project a chat was started in, so older ones
   * fall outside "the latest 300 tasks" and are fetched by their thread.
   */
  private async loadTasks(agentThreads: Record<string, string>): Promise<Task[]> {
    const recent = (await this.call<Task[]>('task.list', { limit: 300 })) ?? [];
    const byId = new Map(recent.map((task) => [task.id, task]));
    const present = new Set(recent.map((task) => threadKey(task)));
    const hidden = await this.call<string>('agents.workspace');
    const fromHidden = hidden === undefined ? [] : (await this.call<Task[]>('task.list', { workspaceId: hidden, limit: 400 })) ?? [];
    for (const task of fromHidden) { byId.set(task.id, task); present.add(threadKey(task)); }
    const missing = Object.keys(agentThreads).filter((key) => !present.has(key)).slice(0, 80);
    const threads = await Promise.all(missing.map((key) => this.call<Task[]>('task.thread', { threadId: key })));
    for (const list of threads) for (const task of list ?? []) byId.set(task.id, task);
    return [...byId.values()];
  }

  /** Threads in the same tiers as the desktop's Work board, plus agent chats. */
  private async work(workspaceId?: string): Promise<unknown> {
    const [approvals = [], questions = [], agentThreads = {}, workspaces = [], groupInfo] = await Promise.all([
      this.call<Array<{ taskId: string; status: string }>>('approval.list'),
      this.call<Array<{ taskId: string; status: string }>>('question.list'),
      this.call<Record<string, string>>('agents.sandbox.threads'),
      this.call<Array<{ id: string; name: string }>>('workspace.list'),
      this.call<{ groupThreads?: Record<string, string> }>('agents.group.list'),
    ]);
    const tasks = await this.loadTasks(agentThreads);
    const inGroup = groupInfo?.groupThreads ?? {};
    const prefs = this.deps.tiers?.get() ?? {};
    const byTask = new Map(tasks.map((task) => [task.id, threadKey(task)]));
    const waiting = new Set(approvals.filter((a) => a.status === 'pending').map((a) => byTask.get(a.taskId) ?? a.taskId));
    const asking = new Set(questions.filter((q) => q.status === 'pending').map((q) => byTask.get(q.taskId) ?? q.taskId));
    const all = groupThreads(tasks).filter((thread) => workspaceId === undefined || thread.root.workspaceId === workspaceId).sort((a, b) => b.latest.updatedAt.localeCompare(a.latest.updatedAt));
    const project = new Map(workspaces.map((w) => [w.id, w.name]));
    const signals = (key: string) => ({ hasPendingApproval: waiting.has(key), hasPendingQuestion: asking.has(key) });
    const groups = groupThreadsByTier(all.filter((thread) => agentThreads[thread.key] === undefined), prefs, (thread) => signals(thread.key));
    const row = (thread: (typeof all)[number]): Record<string, unknown> => {
      const info = classifyThreadTier(thread, prefs[thread.key], signals(thread.key));
      return {
        key: thread.key, title: threadTitle(thread.root), state: thread.latest.state, working: isWorkingState(thread.latest.state),
        updatedAt: thread.latest.updatedAt, project: project.get(thread.root.workspaceId), turns: thread.tasks.length,
        ...(info.attentionLabel !== undefined ? { label: info.attentionLabel } : {}),
        ...(info.tier === 'snoozed' && prefs[thread.key]?.snoozedUntil !== undefined ? { until: prefs[thread.key]!.snoozedUntil } : {}),
        ...(thread.root.prUrl !== undefined ? { pr: thread.root.prUrl } : {}),
      };
    };
    return {
      groups: groups.map((group) => ({ id: group.id, label: group.label, threads: group.threads.map(row) })),
      agentChats: all.filter((thread) => agentThreads[thread.key] !== undefined && inGroup[thread.key] === undefined).map((thread) => ({ ...row(thread), agentId: agentThreads[thread.key] })),
      waiting: waiting.size + asking.size,
    };
  }

  /** Settle, snooze or restore a thread, the way the desktop does. */
  private async tier(key: string, action: unknown, until: string | undefined): Promise<true | string> {
    const tiers = this.deps.tiers;
    if (tiers === undefined || !/^[\w-]{1,64}$/.test(key)) return 'Unknown thread.';
    if (action === 'clear') { tiers.put(key, undefined); return true; }
    const tasks = await this.loadTasks((await this.call<Record<string, string>>('agents.sandbox.threads')) ?? {});
    const thread = groupThreads(tasks).find((t) => t.key === key);
    if (thread === undefined) return 'That thread no longer exists.';
    const seenUpdatedAt = thread.latest.updatedAt;
    if (action === 'settle') { tiers.put(key, { mode: 'settled', seenUpdatedAt } satisfies ThreadTierPref); return true; }
    if (action === 'snooze') {
      if (until !== undefined && (Number.isNaN(Date.parse(until)) || Date.parse(until) <= this.now())) return 'Pick a time in the future.';
      tiers.put(key, { mode: 'snoozed', seenUpdatedAt, ...(until !== undefined ? { snoozedUntil: new Date(until).toISOString() } : {}) });
      return true;
    }
    return 'Unknown action.';
  }

  // ---- watching an agent's sandbox -------------------------------------------------
  // The phone sees the sandbox's desktop through this server: the sandbox's own
  // address and API key stay on the Mac. A watch link is random, expires, and
  // dies with the phone's session.

  private watchFor(path: string): { endpoint: SandboxEndpointLike; rest: string } | undefined {
    const match = /^\/w\/([0-9a-f]{48})(\/.*)?$/.exec(path);
    if (match === null) return undefined;
    const watch = this.watches.get(match[1]!);
    if (watch === undefined || watch.expires < this.now() || !this.sessions.has(watch.session)) return undefined;
    watch.expires = this.now() + WATCH_MS;
    const endpoint = this.deps.sandboxEndpoint?.(watch.agentId);
    return endpoint === undefined ? undefined : { endpoint, rest: match[2] ?? '/' };
  }

  private proxyHeaders(req: IncomingMessage, endpoint: SandboxEndpointLike): Record<string, string | string[] | undefined> {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: new URL(endpoint.baseUrl).host, 'x-aio-api-key': endpoint.apiKey };
    for (const name of ['cookie', 'authorization', 'origin', 'referer']) delete headers[name];
    return headers;
  }

  private proxy(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const found = this.watchFor(url.pathname);
    if (found === undefined || req.method !== 'GET') { res.writeHead(404).end(); return; }
    const target = new URL(found.rest, found.endpoint.baseUrl);
    target.search = url.search;
    const upstream = httpRequest(target, { method: 'GET', headers: this.proxyHeaders(req, found.endpoint) }, (reply) => {
      const headers = { ...reply.headers };
      delete headers['x-frame-options']; delete headers['content-security-policy']; delete headers['set-cookie'];
      headers['cache-control'] = 'no-store';
      res.writeHead(reply.statusCode ?? 502, headers);
      reply.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.end();
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://local');
    const found = this.watchFor(url.pathname);
    if (found === undefined) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const target = new URL(found.rest, found.endpoint.baseUrl);
    target.search = url.search;
    target.searchParams.set('api_key', found.endpoint.apiKey);
    const upstream = httpRequest(target, { method: 'GET', headers: this.proxyHeaders(req, found.endpoint) });
    upstream.on('upgrade', (reply, remote, remoteHead) => {
      const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
      for (let i = 0; i < reply.rawHeaders.length; i += 2) lines.push(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (remoteHead.length > 0) socket.write(remoteHead);
      if (head.length > 0) remote.write(head);
      remote.pipe(socket); socket.pipe(remote);
      const close = (): void => { remote.destroy(); socket.destroy(); };
      remote.on('error', close); socket.on('error', close); remote.on('close', close); socket.on('close', close);
    });
    upstream.on('response', () => { socket.destroy(); });
    upstream.on('error', () => { socket.destroy(); });
    upstream.end();
  }

  // ---- conversations -----------------------------------------------------------------

  private async turnView(task: Task): Promise<Turn> {
    const details = await this.call<TaskDetails>('task.details', { id: task.id });
    const items = details === undefined ? [] : buildTimeline(task, details);
    const messages: Turn['messages'] = [];
    for (const item of items) {
      if (item.kind === 'user') messages.push({ role: 'user', text: item.text, at: item.at });
      else if (item.kind === 'assistant') messages.push({ role: 'agent', text: item.text, at: item.at });
      else if (item.kind === 'error') messages.push({ role: 'error', text: item.text, at: item.at });
    }
    const working = isWorkingState(task.state);
    const activity = working ? latestActivity(items)?.label : undefined;
    return { id: task.id, state: task.state, working, ...(activity !== undefined ? { activity } : {}), messages };
  }

  /** A thread as plain turns for the phone: what was asked, what came back. */
  private async threadView(threadId: string): Promise<{ turns: Turn[]; workspaceId: string | null }> {
    const list = await this.call<Task[]>('task.thread', { threadId });
    const tasks = (list ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { turns: await Promise.all(tasks.map((task) => this.turnView(task))), workspaceId: tasks[0]?.workspaceId ?? null };
  }
}
