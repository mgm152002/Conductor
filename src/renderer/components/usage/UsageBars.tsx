import type { UsageRow } from '@shared/usage';
import { cn } from '../../lib/cn';
import { compactNumber } from '../../lib/usage-format';

// Shared bar visualisations for the Usage destination. The screens used to be
// wall-to-wall tables and six-tile grids, which read as a dense report rather
// than an overview. These helpers keep the same numbers but lead with a single
// proportional bar per group, so the eye can compare rows at a glance.

export type UsageBarTone = 'primary' | 'success' | 'info' | 'warning';

const BAR_FILL: Record<UsageBarTone, string> = {
  primary: 'bg-primary/80',
  success: 'bg-success/80',
  info: 'bg-info/80',
  warning: 'bg-warning/80',
};

export interface UsageBarRow {
  key: string;
  label: string;
  /** Raw value used for the proportional width. */
  value: number;
  /** Formatted value shown at the end of the row. */
  display: string;
  /** Optional cost or secondary figure shown beside the value. */
  cost?: string;
  /** Optional one-line detail shown under the bar. */
  detail?: string;
}

function shareOf(value: number, total: number): number {
  if (total <= 0 || value <= 0) return 0;
  return Math.max(1, Math.round((value / total) * 100));
}

/**
 * One grouped bar list, e.g. "By CLI" or "By project". Rows are sorted by the
 * caller; each bar is relative to the group total, and the percentage is
 * exposed to assistive technology as a progressbar.
 */
export function UsageBarGroup({
  title,
  description,
  rows,
  tone = 'primary',
  emptyLabel = 'No usage in this range.',
  className,
}: {
  title: string;
  description?: string;
  rows: UsageBarRow[];
  tone?: UsageBarTone;
  emptyLabel?: string;
  className?: string;
}): React.JSX.Element {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <section className={cn('flex flex-col gap-2', className)} aria-label={title}>
      <header className="flex items-baseline gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {description !== undefined ? (
          <span className="truncate text-3xs text-muted-foreground/80">{description}</span>
        ) : null}
      </header>

      <div>
        {rows.length === 0 || total <= 0 ? (
          <p className="py-3 text-2xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          rows.map((row, index) => {
            const percent = shareOf(row.value, total);
            return (
              <div
                key={row.key}
                className={cn('flex flex-col gap-1.5 py-2.5', index > 0 && 'border-t border-border/60')}
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{row.label}</span>
                  <span className="text-xs font-semibold text-foreground tabular-nums">{row.display}</span>
                  {row.cost !== undefined ? (
                    <span className="text-3xs text-muted-foreground tabular-nums">{row.cost}</span>
                  ) : null}
                  <span className="w-8 shrink-0 text-right text-3xs text-muted-foreground tabular-nums">{percent}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${row.label} share`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-valuetext={`${percent}% of ${title.toLowerCase()}`}
                  className="h-[3px] w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={cn('h-full rounded-full transition-[width]', BAR_FILL[tone])}
                    style={{ width: `${percent}%` }}
                    aria-hidden="true"
                  />
                </div>
                {row.detail !== undefined ? (
                  <p className="truncate text-3xs text-muted-foreground">{row.detail}</p>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/**
 * A thin input/output split for a token total, with cached and reasoning shown
 * as secondary detail (they overlap the input/output counts, so they are not
 * stacked into the bar).
 */
export function UsageTokenMix({ totals }: { totals: UsageRow }): React.JSX.Element | null {
  const counted = totals.inputTokens + totals.outputTokens;
  if (counted <= 0 && totals.cachedInputTokens <= 0 && totals.reasoningTokens <= 0) return null;
  const inputPercent = counted > 0 ? Math.round((totals.inputTokens / counted) * 100) : 0;
  const outputPercent = counted > 0 ? 100 - inputPercent : 0;

  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-medium text-foreground">Token mix</h3>
        <span className="ml-auto text-3xs text-muted-foreground tabular-nums">
          {compactNumber(totals.inputTokens)} in · {compactNumber(totals.outputTokens)} out
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted/70" aria-hidden="true">
        <div className="h-full bg-primary/80" style={{ width: `${inputPercent}%` }} />
        <div className="h-full bg-info/70" style={{ width: `${outputPercent}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-3xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-primary/80" aria-hidden="true" />
          Input {compactNumber(totals.inputTokens)}
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-info/70" aria-hidden="true" />
          Output {compactNumber(totals.outputTokens)}
        </span>
        {totals.cachedInputTokens > 0 ? <span>{compactNumber(totals.cachedInputTokens)} cached</span> : null}
        {totals.reasoningTokens > 0 ? <span>{compactNumber(totals.reasoningTokens)} reasoning</span> : null}
      </div>
    </div>
  );
}
