import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// AgentMail gives the agents an email inbox of their own. Agents write to the
// user through it ("here are today's jobs, reply to apply"), and a flow can
// wait for the user's reply. Conductor is a desktop app with no public address,
// so replies arrive over AgentMail's WebSocket (the same events a webhook
// would get), and are also looked up directly now and then in case the app was
// closed when one came in.

const REST = 'https://api.agentmail.to/v0';
const SOCKET = 'wss://ws.agentmail.to/v0';
const MAX_BODY = 8_000;
const KEEP_THREADS = 300;

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  /** What the sender wrote this time (quoted earlier mail is cut off). */
  text: string;
  at: string;
}

interface Saved { apiKey: string; owner: string; inboxId: string; /** task id → threads it started */ threads: Record<string, string[]> }

export interface MailStatus { configured: boolean; inbox?: string; owner?: string; listening: boolean }

type Json = Record<string, unknown>;
type Listener = (message: MailMessage) => void;
interface SocketLike { send(data: string): void; close(): void; onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null }

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const address = (from: string): string => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

export class AgentMail {
  private saved: Saved | undefined;
  private socket: SocketLike | undefined;
  private listening = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly seen = new Set<string>();

  constructor(private readonly options: {
    file: string;
    fetch?: typeof fetch;
    /** Opens a WebSocket; defaults to the runtime's own. */
    socket?: (url: string) => SocketLike;
  }) {
    try {
      const value = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<Saved>;
      if (typeof value.apiKey === 'string' && typeof value.inboxId === 'string') {
        this.saved = { apiKey: value.apiKey, owner: text(value.owner), inboxId: value.inboxId, threads: value.threads ?? {} };
      }
    } catch { /* not connected yet */ }
  }

  private get fetcher(): typeof fetch { return this.options.fetch ?? globalThis.fetch; }

  status(): MailStatus {
    return this.saved === undefined ? { configured: false, listening: false }
      : { configured: true, inbox: this.saved.inboxId, ...(this.saved.owner !== '' ? { owner: this.saved.owner } : {}), listening: this.listening };
  }

  private persist(): void {
    if (this.saved === undefined) return;
    mkdirSync(dirname(this.options.file), { recursive: true });
    writeFileSync(this.options.file, JSON.stringify(this.saved), { mode: 0o600 });
    try { chmodSync(this.options.file, 0o600); } catch { /* best effort */ }
  }

  private async api(method: string, path: string, key: string, body?: Json): Promise<Json> {
    const response = await this.fetcher(`${REST}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Json;
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'AgentMail did not accept that API key.' : `AgentMail: ${text(payload['message']) || `error ${response.status}`}`);
    return payload;
  }

  /** Check the key, use its first inbox (or make one), and start listening. `owner` is the address the agents write to. */
  async connect(apiKey: string, owner: string): Promise<MailStatus> {
    const key = apiKey.trim();
    if (!/^am_[A-Za-z0-9_]+$/.test(key)) throw new Error('That does not look like an AgentMail API key (it starts with am_).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.trim())) throw new Error('Enter the email address the agents should write to.');
    const list = await this.api('GET', '/inboxes?limit=1', key);
    const first = (Array.isArray(list['inboxes']) ? list['inboxes'] as Json[] : [])[0];
    const inboxId = first !== undefined ? text(first['inbox_id']) : text((await this.api('POST', '/inboxes', key, { display_name: 'Conductor agents' }))['inbox_id']);
    if (inboxId === '') throw new Error('AgentMail did not return an inbox.');
    this.saved = { apiKey: key, owner: owner.trim().toLowerCase(), inboxId, threads: this.saved?.threads ?? {} };
    this.persist();
    this.listen();
    return this.status();
  }

  disconnect(): void {
    this.stop();
    this.saved = undefined;
    try { writeFileSync(this.options.file, '{}', { mode: 0o600 }); } catch { /* nothing saved */ }
  }

  // ---- what agents do -------------------------------------------------------

  /** Write to the user. Agents can only write to the owner, so a page they read can't turn the inbox against someone else. */
  async send(subject: string, body: string, taskId?: string): Promise<string> {
    const saved = this.need();
    if (saved.owner === '') throw new Error('No address to write to is set.');
    const sent = await this.api('POST', `/inboxes/${encodeURIComponent(saved.inboxId)}/messages/send`, saved.apiKey, { to: saved.owner, subject: subject.slice(0, 200) || '(no subject)', text: body.slice(0, 60_000) });
    const thread = text(sent['thread_id']);
    if (taskId !== undefined && thread !== '') {
      saved.threads[taskId] = [...new Set([...(saved.threads[taskId] ?? []), thread])];
      for (const old of Object.keys(saved.threads).slice(0, Math.max(0, Object.keys(saved.threads).length - KEEP_THREADS))) delete saved.threads[old];
      this.persist();
    }
    return `Sent to ${saved.owner}.`;
  }

  /** Threads the given tasks started, to tell which reply answers which run. */
  threadsFor(taskIds: readonly string[]): string[] {
    return taskIds.flatMap((id) => this.saved?.threads[id] ?? []);
  }

  private toMessage(item: Json): MailMessage {
    return {
      id: text(item['message_id']), threadId: text(item['thread_id']), from: text(item['from']), subject: text(item['subject']),
      text: (text(item['extracted_text']) || text(item['text']) || text(item['preview'])).slice(0, MAX_BODY), at: text(item['timestamp']) || text(item['created_at']),
    };
  }

  /** The newest messages in the inbox (without bodies). */
  async recent(limit = 10): Promise<MailMessage[]> {
    const saved = this.need();
    const listed = await this.api('GET', `/inboxes/${encodeURIComponent(saved.inboxId)}/messages?limit=${Math.min(Math.max(limit, 1), 30)}`, saved.apiKey);
    return (Array.isArray(listed['messages']) ? listed['messages'] as Json[] : []).map((item) => this.toMessage(item));
  }

  async read(id: string): Promise<MailMessage> {
    const saved = this.need();
    return this.toMessage(await this.api('GET', `/inboxes/${encodeURIComponent(saved.inboxId)}/messages/${encodeURIComponent(id)}`, saved.apiKey));
  }

  /** Mail the owner sent since a time, oldest first, with bodies. Used to catch replies that came in while the app was closed. */
  async repliesSince(since: string): Promise<MailMessage[]> {
    const saved = this.need();
    const listed = await this.api('GET', `/inboxes/${encodeURIComponent(saved.inboxId)}/messages?limit=20&ascending=true&after=${encodeURIComponent(since)}`, saved.apiKey);
    const out: MailMessage[] = [];
    for (const item of Array.isArray(listed['messages']) ? listed['messages'] as Json[] : []) {
      const message = this.toMessage(item);
      if (address(message.from) !== saved.owner || message.id === '') continue;
      out.push(await this.read(message.id).catch(() => message));
    }
    return out;
  }

  isOwner(message: MailMessage): boolean { return this.saved !== undefined && address(message.from) === this.saved.owner; }

  private need(): Saved {
    if (this.saved === undefined) throw new Error('Email is not set up. Connect AgentMail in the flow editor first.');
    return this.saved;
  }

  // ---- hearing replies ------------------------------------------------------

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Stay connected to the inbox's live events, reconnecting when the line drops. */
  listen(): void {
    if (this.saved === undefined || this.socket !== undefined) return;
    const saved = this.saved;
    let socket: SocketLike;
    try {
      const url = `${SOCKET}?api_key=${encodeURIComponent(saved.apiKey)}`;
      socket = this.options.socket !== undefined ? this.options.socket(url) : new (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket(url);
    } catch { this.reconnect(); return; }
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.listening = true;
      socket.send(JSON.stringify({ type: 'subscribe', inbox_ids: [saved.inboxId], event_types: ['message.received'] }));
    };
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Json;
        if (data['type'] !== 'event' || data['event_type'] !== 'message.received') return;
        const id = text(data['event_id']);
        if (id !== '') { if (this.seen.has(id)) return; this.seen.add(id); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string); }
        const message = this.toMessage((data['message'] ?? {}) as Json);
        if (message.id !== '') for (const listener of this.listeners) listener(message);
      } catch { /* a frame we don't understand */ }
    };
    const dropped = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.listening = false;
      this.reconnect();
    };
    socket.onclose = dropped;
    socket.onerror = () => { try { socket.close(); } catch { /* already closed */ } dropped(); };
  }

  private reconnect(): void {
    if (this.saved === undefined || this.retryTimer !== undefined) return;
    this.retry += 1;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.listen(); }, Math.min(60_000, 2_000 * 2 ** Math.min(this.retry, 5)));
    this.retryTimer.unref();
  }

  stop(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.listening = false;
    try { socket?.close(); } catch { /* already closed */ }
  }
}
