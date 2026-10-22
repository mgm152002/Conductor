import { readFileSync } from 'node:fs';

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
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { url?: string; apiKey?: string; connectionFile?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
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
