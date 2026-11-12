import { describe, expect, it, vi } from 'vitest';
import {
  estimateCostUsd,
  ModelPricingService,
  PricingCatalog,
  type PricingFetch,
} from '@main/usage/pricing';

// Public pricing: the models.dev catalogue shape, model-id matching, the
// cached-token estimate, and the refresh service keeping its last good
// snapshot. No network: every fetch is injected.

const CATALOGUE = {
  openai: {
    models: {
      'gpt-5': { cost: { input: 1.25, output: 10, cache_read: 0.125 } },
      'gpt-5-mini': { cost: { input: 0.25, output: 2 } },
    },
  },
  anthropic: {
    models: {
      'claude-sonnet-4-5-20250929': { cost: { input: 3, output: 15, cache_read: 0.3 } },
      'claude-sonnet-5': { cost: { input: 2, output: 10 } },
    },
  },
  google: {
    models: {
      'gemini-3.5-flash': { cost: { input: 0.5, output: 3 } },
      'gemma-4-31b-it': {},
    },
  },
  opencode: {
    models: {
      'deepseek-v4-flash-free': { cost: { input: 0, output: 0 } },
    },
  },
};

function catalog(): PricingCatalog {
  const parsed = PricingCatalog.fromModelsDev(CATALOGUE);
  expect(parsed).toBeDefined();
  return parsed!;
}

describe('PricingCatalog parsing and lookup', () => {
  it('parses per-1M input/output/cache prices and skips models without cost', () => {
    const prices = catalog();

    expect(prices.priceFor('gpt-5')).toEqual({ inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125 });
    expect(prices.priceFor('gemma-4-31b-it')).toBeUndefined();
    expect(PricingCatalog.fromModelsDev(undefined)).toBeUndefined();
    expect(PricingCatalog.fromModelsDev({ openai: { models: {} } })).toBeUndefined();
    expect(PricingCatalog.fromModelsDev({ openai: { models: { x: { cost: { input: -1, output: 2 } } } } })).toBeUndefined();
  });

  it('matches provider-qualified, bare, adapter-hinted, and dated model ids', () => {
    const prices = catalog();

    expect(prices.priceFor('openai/gpt-5')).toEqual(prices.priceFor('gpt-5'));
    expect(prices.priceFor('claude-sonnet-5', 'claude-code')).toEqual({ inputPerMillion: 2, outputPerMillion: 10 });
    // A dated report resolves to the same dated catalogue entry, and an
    // undated one still finds it by stripping the stamp.
    expect(prices.priceFor('claude-sonnet-4-5-20250929')?.inputPerMillion).toBe(3);
    expect(prices.priceFor('anthropic/claude-sonnet-4-5')?.inputPerMillion).toBe(3);
    expect(prices.priceFor('models/gemini-3.5-flash', 'antigravity')?.outputPerMillion).toBe(3);
    expect(prices.priceFor('not-a-model')).toBeUndefined();
    expect(prices.priceFor(undefined)).toBeUndefined();
  });

  it('treats free models as a real $0 price', () => {
    const prices = catalog();

    expect(prices.priceFor('deepseek-v4-flash-free', 'opencode')).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
    expect(prices.priceFor('some-other-free', 'opencode')).toEqual({ inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 });
    expect(prices.estimate('deepseek-v4-flash-free', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, 'opencode')).toBe(0);
  });
});

describe('estimateCostUsd', () => {
  it('bills cached input at the cache-read price and the rest at input price', () => {
    const price = { inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 1 };

    // 90 uncached × $10 + 10 cached × $1 + 50 output × $20, per 1M tokens.
    expect(estimateCostUsd(price, { inputTokens: 100, cachedInputTokens: 10, outputTokens: 50 }))
      .toBeCloseTo(0.00191, 10);
  });

  it('falls back to the input price when no cache price is published', () => {
    expect(estimateCostUsd(
      { inputPerMillion: 5, outputPerMillion: 25 },
      { inputTokens: 200, cachedInputTokens: 20, outputTokens: 100 },
    )).toBeCloseTo(0.0035, 10);
  });
});

describe('ModelPricingService', () => {
  function fetchReturning(body: unknown, ok = true): PricingFetch {
    return async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
  }

  it('loads prices from the public catalogue and prices models through priceFor', async () => {
    const service = new ModelPricingService({ fetch: fetchReturning(CATALOGUE) });

    expect(service.priceFor('gpt-5')).toBeUndefined();
    await service.refresh();
    expect(service.priceFor('gpt-5')?.outputPerMillion).toBe(10);
  });

  it('keeps the last good snapshot when a refresh fails or returns junk', async () => {
    let failing = false;
    const fetchImpl: PricingFetch = async () => (failing
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => CATALOGUE });
    const service = new ModelPricingService({ fetch: fetchImpl });

    await service.refresh();
    failing = true;
    await service.refresh();
    expect(service.priceFor('gpt-5')?.inputPerMillion).toBe(1.25);

    const broken = new ModelPricingService({
      fetch: async () => { throw new Error('offline'); },
    });
    await expect(broken.refresh()).resolves.toBeUndefined();
    expect(broken.priceFor('gpt-5')).toBeUndefined();
  });

  it('dedupes concurrent refreshes and does not fetch after stop', async () => {
    const fetchImpl = vi.fn(fetchReturning(CATALOGUE));
    const service = new ModelPricingService({ fetch: fetchImpl });

    await Promise.all([service.refresh(), service.refresh()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    service.stop();
    await service.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('cache-write pricing', () => {
  it('bills cache writes at the cache-write price, reads at the read price', async () => {
    const { estimateCostUsd } = await import('@main/usage/pricing');
    const price = { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2.5 };
    // 1M input = 200k plain + 300k written + 500k read; 100k output.
    const cost = estimateCostUsd(price, { inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteTokens: 300_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo(0.2 * 2 + 0.3 * 2.5 + 0.5 * 0.1 + 0.1 * 10, 6);
  });
});
