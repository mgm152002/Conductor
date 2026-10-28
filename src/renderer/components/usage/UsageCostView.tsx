import type { UsageRange, UsageSummary } from '@shared/usage';
import { compactNumber, formatCost, rangeLabel } from '../../lib/usage-format';
import { UsageTokenMix } from './UsageBars';
import {
  UsageBreakdownTable,
  UsageClientCard,
  UsageMetric,
} from './UsageBreakdownTable';

// The Cost view (Requirement 2.2). For the selected range it shows the money
// reported across sessions, the token mix behind it, one compact card per
// attached CLI (including CLIs with no usage), and the by-agent / by-project /
// by-model breakdowns.
//
// Cost is optional because only some CLIs report it (Claude Code does; Codex
// does not), so a missing total is shown as "Not reported" rather than $0.

export interface UsageCostViewProps {
  summary: UsageSummary;
  range?: UsageRange;
  loading?: boolean;
}

export function UsageCostView({
  summary,
  range = summary.range,
  loading = false,
}: UsageCostViewProps): React.JSX.Element {
  const { totals, clients } = summary;
  const totalCost = totals.costUsd !== undefined ? formatCost(totals.costUsd) : 'Not reported';
  const costReported = clients.some((client) => client.costUsd !== undefined);
  const costBase = clients.reduce((sum, client) => sum + (client.costUsd ?? 0), 0);

  return (
    <section className="flex flex-col gap-6" aria-label="Cost usage">
      <div>
        <p className="text-4xl font-medium tracking-tight text-foreground tabular-nums">{totalCost}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {totals.sessions} sessions · {rangeLabel(range)}{costReported ? ' · reported by attached CLIs' : ' · no CLI reported cost'}
          {loading ? <span role="status" aria-live="polite"> · Refreshing…</span> : null}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 border-y border-border py-3 sm:grid-cols-3">
        <UsageMetric label="Processed tokens" value={compactNumber(totals.totalTokens)} />
        <UsageMetric label="Agent sessions" value={String(totals.sessions)} />
        <UsageMetric label="Total tokens" value={compactNumber(totals.totalTokens)} />
      </dl>

      <UsageTokenMix totals={totals} />

      <section className="flex flex-col" aria-label="Cost by CLI">
        <header className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-medium text-foreground">By CLI</h3>
          <span className="text-3xs text-muted-foreground/80">
            {costReported ? 'Share of reported cost' : 'Share of tokens'}
          </span>
        </header>
        <div className="flex flex-col">
          {clients.map((client) => (
            <UsageClientCard
              key={client.key}
              client={client}
              primaryLabel="Cost"
              primaryValue={client.costUsd !== undefined ? formatCost(client.costUsd) : 'Not reported'}
              primaryHint={client.costUsd === undefined ? 'Cost not reported by this CLI' : undefined}
              sharePercent={costReported && costBase > 0
                ? ((client.costUsd ?? 0) / costBase) * 100
                : totals.totalTokens > 0
                  ? (client.totalTokens / totals.totalTokens) * 100
                  : 0}
            />
          ))}
        </div>
      </section>

      <UsageBreakdownTable title="By agent" rows={summary.byAgent} />
      <div className="grid gap-4 lg:grid-cols-2">
        <UsageBreakdownTable title="By project" rows={summary.byProject} />
        <UsageBreakdownTable title="By model" rows={summary.byModel} />
      </div>
    </section>
  );
}
