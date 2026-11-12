// Public model pricing for token-cost estimates.
//
// Prices come from the public models.dev catalogue (https://models.dev/api.json),
// which aggregates every major provider's published per-model prices into one
// unauthenticated JSON API. Costs there are USD per 1M tokens. The catalogue is
// fetched in the background and cached in memory; a failed refresh keeps the
// last good snapshot, and a model with no published price simply has no
// estimate — its cost is never invented and never taken from a CLI/harness
// report (`total_cost_usd`, ACP `cost`, … are ignored upstream).
//
// Token accounting matches how adapters record usage: cached input tokens are
// a subset of input tokens and are billed at the cache-read price when one is
// published (otherwise the plain input price); reasoning tokens are a subset
// of output tokens and are already billed in the output count.

/** USD per 1M tokens for one model, as published by models.dev. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  /** Writing to the prompt cache (Anthropic bills this above plain input). */
  cacheWritePerMillion?: number;
}

/** Look up a model's public price; `adapterId` hints the provider. */
export type PriceLookup = (model: string | undefined, adapterId?: string) => ModelPrice | undefined;

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const price = (v: unknown): number | undefined => (
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
);

export const MODELS_DEV_PRICING_URL = 'https://models.dev/api.json';
const DAY_MS = 86_400_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Provider to try first for a bare model id reported by each harness. */
const ADAPTER_PROVIDERS: Record<string, string> = {
  codex: 'openai',
  'claude-code': 'anthropic',
  antigravity: 'google',
  opencode: 'opencode',
};

/** Providers preferred when a bare model id exists under several of them. */
const PROVIDER_PRIORITY = ['openai', 'anthropic', 'google', 'opencode', 'opencode-go', 'xai', 'amazon-bedrock'];

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase().replace(/^models\//, '');
}

/**
 * Candidate ids for a reported model, most specific first: the id as given,
 * then with a trailing date/version stamp stripped (`claude-sonnet-4-5-20250929`
 * → `claude-sonnet-4-5`, `gpt-5@2026-01-01` → `gpt-5`).
 */
function modelCandidates(model: string): string[] {
  const base = normalizeModelId(model);
  const candidates = [base];
  let current = base.split('@')[0]!;
  while (current !== candidates[candidates.length - 1]) candidates.push(current);
  for (;;) {
    const stripped = current.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '');
    if (stripped === current || stripped.length === 0) break;
    current = stripped;
    candidates.push(current);
  }
  return [...new Set(candidates)];
}

/** Token counts needed to price one usage row. */
export interface PricedTokens {
  inputTokens: number;
  cachedInputTokens: number;
  /** Cache-write tokens, a subset of input tokens. */
  cacheWriteTokens?: number;
  outputTokens: number;
}

/** Estimated USD cost of one usage row at a model's public prices. */
export function estimateCostUsd(modelPrice: ModelPrice, tokens: PricedTokens): number {
  const cached = Math.min(Math.max(tokens.cachedInputTokens, 0), Math.max(tokens.inputTokens, 0));
  const written = Math.min(Math.max(tokens.cacheWriteTokens ?? 0, 0), Math.max(tokens.inputTokens, 0) - cached);
  const uncached = Math.max(tokens.inputTokens, 0) - cached - written;
  const cachePrice = modelPrice.cacheReadPerMillion ?? modelPrice.inputPerMillion;
  const writePrice = modelPrice.cacheWritePerMillion ?? modelPrice.inputPerMillion;
  return (
    uncached * modelPrice.inputPerMillion
    + cached * cachePrice
    + written * writePrice
    + Math.max(tokens.outputTokens, 0) * modelPrice.outputPerMillion
  ) / 1_000_000;
}

/** A parsed models.dev catalogue. */
export class PricingCatalog {
  private constructor(
    private readonly qualified: ReadonlyMap<string, ModelPrice>,
    private readonly bare: ReadonlyMap<string, ModelPrice>,
  ) {}

  static fromModelsDev(payload: unknown): PricingCatalog | undefined {
    const root = obj(payload);
    if (root === null) return undefined;
    const qualified = new Map<string, ModelPrice>();
    const providerOrder = (id: string): number => {
      const index = PROVIDER_PRIORITY.indexOf(id);
      return index === -1 ? PROVIDER_PRIORITY.length : index;
    };
    const providers = Object.keys(root).sort((a, b) => providerOrder(a) - providerOrder(b) || a.localeCompare(b));
    for (const providerId of providers) {
      const models = obj(obj(root[providerId])?.['models']);
      if (models === null) continue;
      for (const [modelId, raw] of Object.entries(models)) {
        const cost = obj(obj(raw)?.['cost']);
        if (cost === null) continue;
        const input = price(cost['input']);
        const output = price(cost['output']);
        if (input === undefined || output === undefined) continue;
        const cacheRead = price(cost['cache_read']);
        const cacheWrite = price(cost['cache_write']);
        const entry: ModelPrice = {
          inputPerMillion: input,
          outputPerMillion: output,
          ...(cacheRead !== undefined ? { cacheReadPerMillion: cacheRead } : {}),
          ...(cacheWrite !== undefined ? { cacheWritePerMillion: cacheWrite } : {}),
        };
        const qualifiedId = `${providerId}/${normalizeModelId(modelId)}`;
        qualified.set(qualifiedId, entry);
        // Index the undated form too (`claude-sonnet-4-5-20250929` also
        // answers for `claude-sonnet-4-5`), without shadowing an exact entry.
        for (const candidate of modelCandidates(modelId).slice(1)) {
          const key = `${providerId}/${candidate}`;
          if (!qualified.has(key)) qualified.set(key, entry);
        }
      }
    }
    if (qualified.size === 0) return undefined;
    // First provider in priority order wins a bare id; provider-qualified and
    // adapter-hinted lookups still reach every other provider's price.
    const bare = new Map<string, ModelPrice>();
    for (const providerId of providers) {
      for (const [key, entry] of qualified) {
        if (!key.startsWith(`${providerId}/`)) continue;
        const id = key.slice(providerId.length + 1);
        if (!bare.has(id)) bare.set(id, entry);
      }
    }
    return new PricingCatalog(qualified, bare);
  }

  priceFor: PriceLookup = (model, adapterId) => {
    if (model === undefined || model.trim() === '') return undefined;
    const hint = adapterId === undefined ? undefined : ADAPTER_PROVIDERS[adapterId];
    for (const candidate of modelCandidates(model)) {
      const qualifiedHit = this.qualified.get(candidate);
      if (qualifiedHit !== undefined) return qualifiedHit;
      const bareId = candidate.includes('/') ? candidate.split('/').slice(1).join('/') : candidate;
      if (hint !== undefined) {
        const hinted = this.qualified.get(`${hint}/${bareId}`);
        if (hinted !== undefined) return hinted;
      }
      const bareHit = this.bare.get(bareId);
      if (bareHit !== undefined) return bareHit;
      // Free tiers publish a real $0 price, but a `-free` id with no catalogue
      // entry is still a free model, not an unknown one.
      if (bareId.endsWith('-free')) return { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 };
    }
    return undefined;
  };

  estimate(model: string | undefined, tokens: PricedTokens, adapterId?: string): number | undefined {
    const found = this.priceFor(model, adapterId);
    return found === undefined ? undefined : estimateCostUsd(found, tokens);
  }
}

/** The subset of a fetch response the pricing probe needs. */
export interface PricingHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type PricingFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<PricingHttpResponse>;

export interface ModelPricingServiceOptions {
  fetch?: PricingFetch;
  url?: string;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Keeps a current public-pricing catalogue. Refresh failures (offline, bad
 * payload) keep the previous snapshot and never throw into callers.
 */
export class ModelPricingService {
  private readonly fetchImpl: PricingFetch;
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private catalog: PricingCatalog | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(options: ModelPricingServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.url = options.url ?? MODELS_DEV_PRICING_URL;
    this.intervalMs = options.intervalMs ?? DAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  priceFor: PriceLookup = (model, adapterId) => this.catalog?.priceFor(model, adapterId);

  start(): void {
    if (this.interval !== undefined) return;
    this.stopped = false;
    void this.refresh();
    this.interval = setInterval(() => { void this.refresh(); }, this.intervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    this.stopped = true;
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.load().finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async load(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        headers: { Accept: 'application/json', 'User-Agent': 'conductor' },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const catalog = PricingCatalog.fromModelsDev(await response.json().catch(() => undefined));
      if (catalog !== undefined && !this.stopped) this.catalog = catalog;
    } catch {
      // Offline or a broken catalogue: keep the last good prices.
    } finally {
      clearTimeout(timer);
    }
  }
}
