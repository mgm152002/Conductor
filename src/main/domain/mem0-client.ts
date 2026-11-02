import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Self-hosted Mem0 REST API. No alternate retrieval implementation. */
export interface Mem0Memory {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  user_id?: string;
  run_id?: string;
  score?: number;
}

export class Mem0Error extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'Mem0Error';
  }
}

export class Mem0Client {
  private baseUrl: string;
  private apiKey: string | undefined;
  private readonly connectionFile: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { url?: string; apiKey?: string; connectionFile?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.connectionFile = options.connectionFile;
    let saved: { url?: string; apiKey?: string } = {};
    if (options.connectionFile !== undefined) {
      try {
        const value: unknown = JSON.parse(readFileSync(options.connectionFile, 'utf8'));
        if (value === null || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string'
          || !('apiKey' in value) || typeof value.apiKey !== 'string') throw new Error('Invalid configuration');
        saved = { url: value.url, apiKey: value.apiKey };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Mem0Error('Invalid local Mem0 connection configuration');
      }
    }
    this.baseUrl = (options.url ?? process.env['CONDUCTOR_MEM0_URL'] ?? saved.url ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
    const url = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Mem0Error('Invalid Mem0 URL');
    this.apiKey = options.apiKey ?? process.env['CONDUCTOR_MEM0_API_KEY']
      ?? (this.baseUrl === saved.url?.replace(/\/+$/, '') ? saved.apiKey : undefined);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Validate a Mem0 base URL (http/https, no credentials/query/fragment) and strip trailing slashes. */
  static normalizeUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, '');
    let url: URL;
    try { url = new URL(trimmed); } catch { throw new Mem0Error('Enter a valid URL, for example http://127.0.0.1:8000'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Mem0Error('Invalid Mem0 URL');
    return trimmed;
  }

  /**
   * Check a url/key pair without saving it: the service must answer /health,
   * and the key must be accepted by an authenticated read. Never throws.
   */
  async test(input: { url: string; apiKey: string }): Promise<{ ok: boolean; detail?: string }> {
    let base: string;
    try { base = Mem0Client.normalizeUrl(input.url); } catch (error) { return { ok: false, detail: (error as Error).message }; }
    try {
      const health = await this.fetcher(`${base}/health`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000)) });
      if (!health.ok) return { ok: false, detail: `Mem0 responded with HTTP ${health.status}.` };
    } catch { return { ok: false, detail: 'Mem0 is unreachable. Check the URL and that the service is running.' }; }
    try {
      const auth = await this.fetcher(`${base}/memories?${new URLSearchParams({ user_id: 'conductor-setup-check', top_k: '1' })}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000)),
        headers: { 'X-API-Key': input.apiKey },
      });
      if (auth.status === 401 || auth.status === 403) return { ok: false, detail: 'Mem0 rejected the API key.' };
    } catch { return { ok: false, detail: 'Mem0 became unreachable while checking the API key.' }; }
    return { ok: true };
  }

  /** Persist a new connection (0600) and use it immediately. */
  configure(input: { url: string; apiKey: string }): void {
    if (this.connectionFile === undefined) throw new Mem0Error('This Mem0 client has no connection file to save to');
    const url = Mem0Client.normalizeUrl(input.url);
    const apiKey = input.apiKey.trim();
    if (apiKey === '') throw new Mem0Error('Enter the Mem0 API key');
    mkdirSync(dirname(this.connectionFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.connectionFile, `${JSON.stringify({ url, apiKey })}\n`, { mode: 0o600 });
    chmodSync(this.connectionFile, 0o600);
    this.baseUrl = url;
    this.apiKey = apiKey;
  }

  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Mem0Error('Mem0 is unavailable or timed out. Check CONDUCTOR_MEM0_URL and the Mem0 service.'); }
    // Never echo upstream bodies: they can contain memory content or credentials.
    if (!response.ok) throw new Mem0Error(`Mem0 request failed (HTTP ${response.status})`, response.status);
    try { return await response.json(); } catch { throw new Mem0Error('Mem0 returned invalid JSON'); }
  }

  private memories(value: unknown): Mem0Memory[] {
    const results = (value as { results?: unknown } | null)?.results;
    if (!Array.isArray(results) || results.some((r) => !r || typeof r.id !== 'string' || !r.id || typeof r.memory !== 'string')) throw new Mem0Error('Mem0 returned an invalid memory result');
    return results as Mem0Memory[];
  }

  /**
   * Liveness probe against the service's unauthenticated `/health` endpoint.
   * Resolves rather than throwing so a renderer status badge can show the
   * reason. Uses a short timeout independent of the request timeout so a
   * health check never blocks the UI for long.
   */
  async health(): Promise<{ reachable: boolean; detail?: string }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/health`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000)),
      });
    } catch {
      return { reachable: false, detail: 'Mem0 is unreachable. Check that the memory service is running.' };
    }
    if (!response.ok) return { reachable: false, detail: `Mem0 responded with HTTP ${response.status}.` };
    return { reachable: true };
  }

  async add(userId: string, id: string, content: string, metadata: Record<string, unknown>): Promise<Mem0Memory> {
    const results = this.memories(await this.request('/memories', 'POST', {
      user_id: userId, run_id: id, messages: [{ role: 'user', content }], metadata, infer: false,
    }));
    if (results.length !== 1) throw new Mem0Error('Mem0 must acknowledge exactly one verbatim memory');
    return results[0]!;
  }

  async list(userId: string, id: string): Promise<Mem0Memory[]> {
    return this.memories(await this.request(`/memories?${new URLSearchParams({ user_id: userId, run_id: id, top_k: '1000', show_expired: 'true' })}`));
  }

  async get(id: string): Promise<Mem0Memory> {
    const result = await this.request(`/memories/${encodeURIComponent(id)}`) as Mem0Memory;
    if (!result || result.id !== id || typeof result.memory !== 'string') throw new Mem0Error('Mem0 returned an invalid memory');
    return result;
  }

  async search(userId: string, ids: string[], query: string, limit: number): Promise<Mem0Memory[]> {
    return this.memories(await this.request('/search', 'POST', {
      query, filters: { user_id: userId, conductor_id: { in: ids } }, top_k: limit,
    }));
  }

  async update(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.request(`/memories/${encodeURIComponent(id)}`, 'PUT', { metadata });
  }

  async delete(id: string): Promise<void> {
    try { await this.request(`/memories/${encodeURIComponent(id)}`, 'DELETE'); }
    catch (error) { if (!(error instanceof Mem0Error) || error.status !== 404) throw error; }
  }
}
