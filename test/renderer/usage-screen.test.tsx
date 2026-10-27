import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UsageClient, UsageSummary } from '../../src/shared/usage';
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen';
import { UsageScreenView } from '../../src/renderer/screens/UsageScreen';
import { USAGE_RANGES } from '../../src/renderer/lib/usage-format';

// Renderer coverage for the Usage destination (Requirements 2.1–2.5, 5.2).
// `UsageScreenView` is intentionally pure: every test drives it with a summary,
// loading/error flags, a view, and a range, so no preload bridge is needed.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const ZERO = {
  sessions: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

function attachedClients(): UsageClient[] {
  const now = Date.now();
  return [
    {
      key: 'codex',
      label: 'Codex',
      sessions: 2,
      inputTokens: 12_000,
      cachedInputTokens: 2000,
      outputTokens: 4000,
      reasoningTokens: 500,
      totalTokens: 18_000,
      costUsd: 0.42,
      limits: [
        {
          kind: 'session',
          remainingPercent: 0,
          usedPercent: 100,
          resetsAt: new Date(now + 63 * MINUTE + 30_000).toISOString(),
          source: 'codex',
        },
        {
          kind: 'weekly',
          remainingPercent: 12,
          usedPercent: 88,
          resetsAt: new Date(now + 5 * DAY + 30_000).toISOString(),
          source: 'codex',
        },
      ],
    },
    {
      // Attached but idle: it must still get a card with an explicit empty
      // state, and it reports no limit windows at all.
      key: 'claude-code',
      label: 'Claude Code',
      ...ZERO,
      limits: [],
    },
    {
      // Antigravity reports one weekly window per model group; the label keeps
      // the stored "most constrained" group identifiable.
      key: 'antigravity',
      label: 'Antigravity',
      ...ZERO,
      limits: [{
        kind: 'weekly',
        remainingPercent: 0,
        usedPercent: 100,
        resetsAt: new Date(now + 5 * DAY).toISOString(),
        source: 'antigravity',
        label: 'Gemini Models',
      }],
    },
  ];
}

function summary(): UsageSummary {
  const clients = attachedClients();
  return {
    range: '7d',
    totals: {
      key: 'totals',
      label: 'Total',
      sessions: 2,
      inputTokens: 12_000,
      cachedInputTokens: 2000,
      outputTokens: 4000,
      reasoningTokens: 500,
      totalTokens: 18_000,
      costUsd: 0.42,
    },
    byAgent: [clients[0]!],
    byProject: [],
    byModel: [],
    clients,
  };
}

function renderUsage(overrides: {
  view?: 'cost' | 'tokens' | 'limits';
  range?: UsageSummary['range'];
} = {}): string {
  return renderToStaticMarkup(
    createElement(UsageScreenView, {
      summary: summary(),
      loading: false,
      error: null,
      view: overrides.view ?? 'cost',
      range: overrides.range ?? '7d',
    }),
  );
}

/** The opening tag of the native button carrying an exact label. */
function buttonTag(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  return match?.[0] ?? '';
}

function expectPressed(html: string, label: string, pressed: boolean): void {
  const tag = buttonTag(html, label);
  expect(tag, `${label} should render as a native button`).toContain('type="button"');
  expect(tag).toContain(`aria-pressed="${pressed}"`);
}

/** The opening tag of one progress bar, so aria attributes can be asserted. */
function progressbarTag(html: string, label: string): string {
  const match = new RegExp(`<div role="progressbar" aria-label="${label}"[^>]*>`).exec(html);
  return match?.[0] ?? '';
}

describe('Usage screen views', () => {
  it('switches between Cost, Tokens, and Limits and marks the selected view', () => {
    const cost = renderUsage({ view: 'cost' });
    expect(cost).toContain('aria-label="Cost usage"');
    expect(cost).toContain('>Cost</button>');
    expect(cost).toContain('>$0.42<');
    expectPressed(cost, 'Cost', true);
    expectPressed(cost, 'Tokens', false);
    expectPressed(cost, 'Limits', false);

    const tokens = renderUsage({ view: 'tokens' });
    expect(tokens).toContain('aria-label="Token usage"');
    expect(tokens).toContain('>Total tokens<');
    expect(tokens).toContain('>18k<');
    expectPressed(tokens, 'Cost', false);
    expectPressed(tokens, 'Tokens', true);
    expectPressed(tokens, 'Limits', false);

    const limits = renderUsage({ view: 'limits' });
    expect(limits).toContain('aria-label="CLI usage limits"');
    expect(limits).toContain('aria-label="Codex limits"');
    expectPressed(limits, 'Cost', false);
    expectPressed(limits, 'Tokens', false);
    expectPressed(limits, 'Limits', true);
  });

  it('renders all five range chips and marks only the selected range', () => {
    const expected = ['Past 24h', '7 days', '30 days', '90 days', 'All time'];
    expect(USAGE_RANGES.map((entry) => entry.label)).toEqual(expected);

    for (const range of USAGE_RANGES) {
      const html = renderUsage({ range: range.id });
      for (const label of expected) {
        expectPressed(html, label, label === range.label);
      }
    }
  });

  it('keeps view and range controls keyboard accessible native buttons', () => {
    const html = renderUsage();
    expect(html).toContain('role="group" aria-label="Usage view"');
    expect(html).toContain('role="group" aria-label="Usage range"');
    for (const label of ['Cost', 'Tokens', 'Limits', 'Past 24h', '7 days', '30 days', '90 days', 'All time']) {
      const tag = buttonTag(html, label);
      expect(tag).toContain('type="button"');
      expect(tag).toContain('focus-visible:outline');
    }
  });
});

describe('Usage per-CLI cards', () => {
  it('renders a card for an attached CLI with no usage in the selected range', () => {
    const html = renderUsage({ view: 'cost' });

    expect(html).toContain('aria-label="Codex usage"');
    expect(html).toContain('aria-label="Claude Code usage"');

    const cardMatch = /<article aria-label="Claude Code usage"[^>]*>([\s\S]*?)<\/article>/.exec(html);
    const card = cardMatch?.[1] ?? '';
    expect(card).toContain('>Claude Code<');
    expect(card).toContain('>No usage<');
    expect(card).toContain('No usage recorded for this CLI in the selected range.');
  });
});

describe('Usage Limits cards', () => {
  it('exposes a 12 percent weekly limit through progressbar aria attributes', () => {
    const html = renderUsage({ view: 'limits' });
    const bar = progressbarTag(html, 'Codex weekly limit');

    expect(bar).toContain('aria-valuemin="0"');
    expect(bar).toContain('aria-valuemax="100"');
    expect(bar).toContain('aria-valuenow="12"');
    expect(bar).toContain('aria-valuetext="12% left"');

    expect(html).toContain('12%');
    expect(html).toContain('left');
    expect(html).toMatch(/Resets in 5d/);

    // A reported zero is a real exhausted window, not "not reported".
    const session = progressbarTag(html, 'Codex session limit');
    expect(session).toContain('aria-valuenow="0"');
    expect(session).toContain('aria-valuetext="0% left"');
    expect(html).toMatch(/Resets in 1h/);
  });

  it('shows the provider label for a multi-group quota window', () => {
    const html = renderUsage({ view: 'limits' });
    const bar = progressbarTag(html, 'Antigravity Gemini Models weekly limit');

    expect(html).toContain('Gemini Models');
    expect(bar).toContain('aria-valuenow="0"');
    expect(bar).toContain('aria-valuetext="0% left"');
  });

  it('shows the not-reported state instead of a fabricated percentage', () => {
    const html = renderUsage({ view: 'limits' });
    const session = progressbarTag(html, 'Claude Code session limit');
    const weekly = progressbarTag(html, 'Claude Code weekly limit');

    expect(html).toContain('aria-label="Claude Code limits"');
    expect(html).toContain('Not reported by this CLI');

    for (const bar of [session, weekly]) {
      expect(bar).toContain('aria-valuemin="0"');
      expect(bar).toContain('aria-valuemax="100"');
      expect(bar).toContain('aria-valuetext="Not reported by this CLI"');
      expect(bar).not.toContain('aria-valuenow');
    }
  });
});

describe('Settings usage removal', () => {
  it('no longer renders the usage section or its range controls', () => {
    const html = renderToStaticMarkup(createElement(SettingsScreen));

    expect(html).toContain('>Settings<');
    expect(html).not.toContain('aria-label="Usage"');
    expect(html).not.toContain('>Usage<');
    expect(html).not.toContain('Last 7 days');
    expect(html).not.toContain('Last 30 days');
    expect(html).not.toContain('Usage statistics');
  });
});
