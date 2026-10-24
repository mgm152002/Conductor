import { useEffect, useState } from 'react';
import type { UsageRange, UsageRow, UsageSummary } from '@shared/usage';
import { compactNumber, formatCost } from '../../lib/usage-format';
import { Alert, Button } from '../ui/primitives';

// Token usage recorded from agent sessions: totals, by agent, by project and
// by model, for the last 7 days, 30 days or all time.

const RANGES: { id: UsageRange; label: string }[] = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
];

function Table({ title, rows }: { title: string; rows: UsageRow[] }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  const anyCost = rows.some((r) => r.costUsd !== undefined);
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Name</th>
              <th className="px-3 py-1.5 text-right font-medium">Sessions</th>
              <th className="px-3 py-1.5 text-right font-medium">Input</th>
              <th className="px-3 py-1.5 text-right font-medium">Output</th>
              <th className="px-3 py-1.5 text-right font-medium">Total</th>
              {anyCost ? <th className="px-3 py-1.5 text-right font-medium">Cost</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border tabular-nums">
                <td className="px-3 py-1.5 text-foreground">{row.label}</td>
                <td className="px-3 py-1.5 text-right">{row.sessions}</td>
                <td className="px-3 py-1.5 text-right" title={`${row.cachedInputTokens.toLocaleString()} cached`}>{compactNumber(row.inputTokens)}</td>
                <td className="px-3 py-1.5 text-right" title={row.reasoningTokens > 0 ? `${row.reasoningTokens.toLocaleString()} reasoning` : undefined}>{compactNumber(row.outputTokens)}</td>
                <td className="px-3 py-1.5 text-right font-medium text-foreground">{compactNumber(row.totalTokens)}</td>
                {anyCost ? <td className="px-3 py-1.5 text-right">{row.costUsd !== undefined ? formatCost(row.costUsd) : '—'}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UsageSettings(): React.JSX.Element {
  const [range, setRange] = useState<UsageRange>('7d');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    window.conductor.usage.summary({ range })
      .then((value) => { if (active) setSummary(value); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : 'Could not load usage'); });
    return () => { active = false; };
  }, [range, revision]);

  const totals = summary?.totals;
  return (
    <section className="flex flex-col gap-3" aria-label="Usage">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Usage</h2>
        <div className="ml-auto flex gap-1" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <Button key={r.id} size="xs" variant={range === r.id ? 'default' : 'ghost'} aria-pressed={range === r.id} onClick={() => { setRange(r.id); }}>{r.label}</Button>
          ))}
          <Button size="xs" variant="ghost" onClick={() => { setRevision((n) => n + 1); }}>Refresh</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Tokens reported by each agent CLI for the sessions Conductor ran, including planners. Codex, Claude Code, OpenCode and Antigravity report token counts; Claude Code also reports cost. Agents that report nothing are not listed.
      </p>
      {error !== null ? <Alert>{error}</Alert> : null}
      {totals !== undefined ? (
        totals.sessions === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No usage recorded in this period.</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ['Total tokens', compactNumber(totals.totalTokens)],
                ['Input', `${compactNumber(totals.inputTokens)} (${compactNumber(totals.cachedInputTokens)} cached)`],
                ['Output', compactNumber(totals.outputTokens)],
                ['Agent sessions', String(totals.sessions)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border px-3 py-2">
                  <dt className="text-3xs text-muted-foreground uppercase">{label}</dt>
                  <dd className="text-sm font-semibold text-foreground tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <Table title="By agent" rows={summary!.byAgent} />
            <Table title="By project" rows={summary!.byProject} />
            <Table title="By model" rows={summary!.byModel} />
          </>
        )
      ) : error === null ? <p className="text-xs text-muted-foreground">Loading usage…</p> : null}
    </section>
  );
}
