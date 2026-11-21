import { useMemo, useState } from 'react';
import type { UsageClient, UsageRow, UsageSummary } from '@shared/usage';
import { agentBrand, BrandMark } from '../ui/BrandMarks';
import { cn } from '../../lib/cn';
import { compactNumber, formatCost, rangeLabel } from '../../lib/usage-format';

// The Cost and Tokens views, laid out as a usage page: a large total with each CLI listed under it, the daily chart beside
// it, a totals row, the split by type and a breakdown table. Flat, on the
// page, without cards.

export type UsageMetric = 'cost' | 'tokens';

/** A CLI's colour in the list dot, the chart and nowhere else. */
const CLIENT_COLORS: Record<string, string> = {
  codex: 'var(--foreground)',
  'claude-code': '#d97757',
  opencode: '#5b9bd5',
  antigravity: '#8b7cf6',
  kiro: '#c2569b',
  'command-code': '#2a9763',
};
const FALLBACK_COLORS = ['#c58c1c', '#1f9bb0', '#e0602c', '#7c5ce0'];
const colorOf = (key: string, index: number): string => CLIENT_COLORS[key] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!;

const value = (row: Pick<UsageRow, 'costUsd' | 'totalTokens'>, metric: UsageMetric): number => (metric === 'cost' ? row.costUsd ?? 0 : row.totalTokens);
const show = (n: number, metric: UsageMetric): string => (metric === 'cost' ? formatCost(n) : compactNumber(n));

function ClientRow({ client, metric, total, color }: { client: UsageClient; metric: UsageMetric; total: number; color: string }): React.JSX.Element {
  const used = client.totalTokens > 0 || client.sessions > 0;
  const own = value(client, metric);
  const share = total > 0 ? (own / total) * 100 : 0;
  return (
    <article aria-label={`${client.label} usage`} className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        <BrandMark brand={agentBrand(client.key)} size={18} />
        <span className="min-w-0 truncate text-base text-foreground">{client.label}</span>
        <span className="shrink-0 text-sm text-muted-foreground">{client.sessions} {client.sessions === 1 ? 'session' : 'sessions'}</span>
        <span className="ms-auto shrink-0 text-base text-foreground tabular-nums">
          {!used ? 'No usage' : metric === 'cost' && client.costUsd === undefined ? 'No public pricing' : show(own, metric)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {!used ? 'No usage recorded for this CLI in the selected range.'
          : metric === 'cost'
            ? `${share.toFixed(1)}% of cost · ${compactNumber(client.totalTokens)} tokens`
            : `${share.toFixed(1)}% of tokens${client.costUsd !== undefined ? ` · ${formatCost(client.costUsd)}` : ''}`}
      </p>
    </article>
  );
}

/** Smooth path through points (Catmull-Rom as cubic Béziers), never dipping below the baseline. */
function smooth(points: Array<[number, number]>, floor: number): string {
  if (points.length === 0) return '';
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1y = Math.min(floor, p1[1] + (p2[1] - p0[1]) / 6);
    const c2y = Math.min(floor, p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${c1y} ${p2[0] - (p3[0] - p1[0]) / 6},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 4, 5, 8, 10]) if (m * step >= max) return m * step;
  return 10 * step;
}

const dayLabel = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();

function DailyChart({ summary, metric, clients }: { summary: UsageSummary; metric: UsageMetric; clients: Array<{ key: string; color: string }> }): React.JSX.Element {
  const days = useMemo(() => {
    const recorded = summary.daily ?? [];
    if (recorded.length === 0) return [];
    // Every day in the span, so quiet days read as zero rather than being skipped.
    const out: string[] = [];
    const start = new Date(`${recorded[0]!.day}T12:00:00`);
    const end = new Date();
    const span = summary.range === '24h' ? 1 : summary.range === '7d' ? 7 : summary.range === '30d' ? 30 : summary.range === '90d' ? 90 : null;
    const from = span !== null ? new Date(end.getTime() - (span - 1) * 86_400_000) : start;
    for (let at = new Date(from); at <= end; at = new Date(at.getTime() + 86_400_000)) out.push(at.toLocaleDateString('en-CA'));
    return out;
  }, [summary.daily, summary.range]);
  const byDay = new Map((summary.daily ?? []).map((entry) => [entry.day, entry.byClient]));
  const series = clients.map((client) => ({
    ...client,
    values: days.map((day) => { const slot = byDay.get(day)?.[client.key]; return metric === 'cost' ? slot?.costUsd ?? 0 : slot?.tokens ?? 0; }),
  })).filter((entry) => entry.values.some((v) => v > 0));
  const max = niceMax(Math.max(0, ...series.flatMap((entry) => entry.values)));
  const W = 600; const H = 220; const left = 56; const bottom = H - 18;
  const x = (i: number): number => left + (days.length <= 1 ? 0 : (i / (days.length - 1)) * (W - left));
  const y = (v: number): number => 6 + (1 - v / max) * (bottom - 6);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const label = (v: number): string => (v === 0 ? '0' : metric === 'cost' ? formatCost(v) : compactNumber(v));
  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <figcaption className="text-base font-medium text-foreground">{metric === 'cost' ? 'Daily cost' : 'Daily processed tokens'}</figcaption>
      {days.length === 0 ? <p className="py-16 text-center text-sm text-muted-foreground">No usage in this range.</p> : (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="img" aria-label={metric === 'cost' ? 'Daily cost by CLI' : 'Daily tokens by CLI'}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={left} x2={W} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
              <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">{label(tick)}</text>
            </g>
          ))}
          {series.map((entry) => {
            const points = entry.values.map((v, i) => [x(i), y(v)] as [number, number]);
            const line = smooth(points, bottom);
            return (
              <g key={entry.key}>
                <path d={`${line} L${x(days.length - 1)},${bottom} L${x(0)},${bottom} Z`} fill={entry.color} fillOpacity={0.12} />
                <path d={line} fill="none" stroke={entry.color} strokeWidth={1.75} strokeLinejoin="round" />
              </g>
            );
          })}
          {[0, Math.floor((days.length - 1) / 2), days.length - 1].filter((i, index, list) => list.indexOf(i) === index).map((i) => (
            <text key={i} x={x(i)} y={H - 2} textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'} className="fill-muted-foreground text-[9px] tracking-wide">{dayLabel(days[i]!)}</text>
          ))}
        </svg>
      )}
    </figure>
  );
}

const TYPE_SHADES = ['color-mix(in oklab, var(--foreground) 55%, var(--background))', 'color-mix(in oklab, var(--foreground) 28%, var(--background))', 'color-mix(in oklab, var(--foreground) 70%, var(--background))', 'var(--foreground)'];

function ByType({ summary, metric }: { summary: UsageSummary; metric: UsageMetric }): React.JSX.Element | null {
  const parts = metric === 'cost' ? summary.byType?.costUsd : summary.byType?.tokens;
  if (parts === undefined) return null;
  const items = [
    { label: 'Input', value: parts.input },
    { label: 'Cache read', value: parts.cacheRead },
    { label: 'Cache write', value: parts.cacheWrite },
    { label: 'Output', value: parts.output },
  ];
  const sum = items.reduce((total, item) => total + item.value, 0);
  if (sum <= 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label={metric === 'cost' ? 'Cost by type' : 'Tokens by type'}>
      <h3 className="text-base font-medium text-foreground">{metric === 'cost' ? 'Cost by type' : 'Tokens by type'}</h3>
      <div className="flex h-2.5 w-full max-w-[40rem] gap-0.5">
        {items.map((item, index) => item.value > 0 ? (
          <span key={item.label} className="h-full rounded-full first:rounded-s-full last:rounded-e-full" style={{ width: `${(item.value / sum) * 100}%`, minWidth: 6, background: TYPE_SHADES[index] }} />
        ) : null)}
      </div>
      <ul className="flex max-w-[40rem] flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
        {items.map((item, index) => (
          <li key={item.label} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: TYPE_SHADES[index] }} />
            {item.label}<span className="text-foreground tabular-nums">{show(item.value, metric)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type BreakdownBy = 'model' | 'agent' | 'project';

function Breakdown({ summary, metric }: { summary: UsageSummary; metric: UsageMetric }): React.JSX.Element {
  const [by, setBy] = useState<BreakdownBy>('model');
  const rows = by === 'model' ? summary.byModel : by === 'agent' ? summary.byAgent : summary.byProject;
  const sorted = [...rows].sort((a, b) => value(b, metric) - value(a, metric) || b.totalTokens - a.totalTokens);
  const total = sorted.reduce((sum, row) => sum + value(row, metric), 0);
  return (
    <section className="flex flex-col gap-3" aria-label="Breakdown">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium text-foreground">Breakdown</h3>
        <div role="group" aria-label="Break down by" className="seg-control">
          {(['model', 'agent', 'project'] as const).map((option) => (
            <button key={option} type="button" aria-pressed={by === option} data-active={by === option} onClick={() => { setBy(option); }} className="seg-item focus-visible:outline-2 focus-visible:outline-ring">
              {option === 'model' ? 'Model' : option === 'agent' ? 'CLI' : 'Project'}
            </button>
          ))}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="w-8 pb-2 text-start font-normal">#</th>
            <th className="pb-2 text-start font-normal">{by === 'model' ? 'Model' : by === 'agent' ? 'CLI' : 'Project'}</th>
            <th className="w-24 pb-2 text-end font-normal">Cost</th>
            <th className="w-20 pb-2 text-end font-normal">Share</th>
            <th className="w-20 pb-2 text-end font-normal">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => {
            const [cli, model] = by === 'model' ? row.label.split(' · ') : [row.label, undefined];
            return (
              <tr key={row.key} className="border-b border-border/50 last:border-0">
                <td className="py-2.5 text-muted-foreground tabular-nums">{index + 1}</td>
                <td className="py-2.5">
                  <span className="flex min-w-0 items-center gap-2 text-foreground">
                    {by !== 'project' ? <BrandMark brand={agentBrand(by === 'agent' ? row.key : row.key.split(' · ')[0])} size={16} /> : null}
                    <span className="truncate">{model ?? cli}</span>
                    {model !== undefined ? <span className="truncate text-muted-foreground">{cli}</span> : null}
                  </span>
                </td>
                <td className="py-2.5 text-end text-foreground tabular-nums">{row.costUsd !== undefined ? formatCost(row.costUsd) : '—'}</td>
                <td className="py-2.5 text-end text-foreground tabular-nums">{total > 0 ? `${((value(row, metric) / total) * 100).toFixed(1)}%` : '—'}</td>
                <td className="py-2.5 text-end text-foreground tabular-nums">{compactNumber(row.totalTokens)}</td>
              </tr>
            );
          })}
          {sorted.length === 0 ? <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">No usage in this range.</td></tr> : null}
        </tbody>
      </table>
    </section>
  );
}

export function UsageOverview({ summary, metric, loading = false }: { summary: UsageSummary; metric: UsageMetric; loading?: boolean }): React.JSX.Element {
  const { totals } = summary;
  const clients = [...summary.clients].sort((a, b) => value(b, metric) - value(a, metric) || b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));
  const colored = clients.map((client, index) => ({ client, color: colorOf(client.key, index) }));
  const total = clients.reduce((sum, client) => sum + value(client, metric), 0);
  const priced = totals.costUsd !== undefined;
  // Prefer the by-type split (CLIs differ on whether input counts cached tokens).
  const cachedInput = summary.byType?.tokens.cacheRead ?? Math.min(totals.cachedInputTokens, totals.inputTokens);
  const uncachedInput = summary.byType !== undefined ? summary.byType.tokens.input + summary.byType.tokens.cacheWrite : Math.max(0, totals.inputTokens - cachedInput);
  return (
    <section className="flex flex-col gap-10" aria-label={metric === 'cost' ? 'Cost usage' : 'Token usage'}>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <div>
            <p className="text-5xl font-semibold tracking-tight text-foreground tabular-nums">
              {metric === 'cost' ? (priced ? formatCost(totals.costUsd ?? 0) : 'No public pricing') : compactNumber(totals.totalTokens)}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {totals.sessions} sessions{metric === 'cost' ? ' · API estimate' : ''} · {rangeLabel(summary.range)}
              {loading ? <span role="status" aria-live="polite"> · Refreshing…</span> : null}
            </p>
          </div>
          <div className="flex flex-col gap-4">
            {colored.map(({ client, color }) => <ClientRow key={client.key} client={client} metric={metric} total={total} color={color} />)}
          </div>
        </div>
        <DailyChart summary={summary} metric={metric} clients={colored.map(({ client, color }) => ({ key: client.key, color }))} />
      </div>

      <section className="flex flex-col gap-3" aria-label="Totals">
        <h3 className="text-base font-medium text-foreground">Totals</h3>
        <dl className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          {[
            ['Processed tokens', compactNumber(totals.totalTokens)],
            ['Cached input', compactNumber(cachedInput)],
            ['Uncached input', compactNumber(uncachedInput)],
            ['Output', compactNumber(totals.outputTokens)],
            ['Reasoning', compactNumber(totals.reasoningTokens)],
          ].map(([label, shown]) => (
            <div key={label} className="flex flex-col gap-1">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className={cn('text-xl text-foreground tabular-nums')}>{shown}</dd>
            </div>
          ))}
        </dl>
      </section>

      <ByType summary={summary} metric={metric} />
      <Breakdown summary={summary} metric={metric} />
    </section>
  );
}
