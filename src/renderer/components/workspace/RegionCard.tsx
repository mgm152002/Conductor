// Shared chrome for an inspection region (plan, checks, files, context,
// activity). Rendered flat inside the thread details panel: a small heading
// row with an optional count and subtitle, then content or an empty label.
interface RegionCardProps {
  title: string;
  subtitle?: string;
  /** Count badge shown next to the title. */
  count?: number;
  /** Rendered when there is nothing to show yet. */
  emptyLabel: string;
  /** Whether the region currently has content. */
  isEmpty: boolean;
  children?: React.ReactNode;
}

export function RegionCard({ title, subtitle, count, emptyLabel, isEmpty, children }: RegionCardProps): React.JSX.Element {
  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-3 [overflow-wrap:anywhere]" aria-label={title}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-xs font-semibold text-foreground">{title}</h2>
          {count !== undefined && count > 0 ? (
            <span className="rounded-full bg-accent px-1.5 text-3xs font-medium text-muted-foreground tabular-nums">{count}</span>
          ) : null}
        </div>
        {subtitle !== undefined ? <p className="text-2xs text-muted-foreground">{subtitle}</p> : null}
      </header>
      <div className="min-h-0 flex-1">
        {isEmpty ? <p className="text-xs text-muted-foreground/80">{emptyLabel}</p> : children}
      </div>
    </section>
  );
}
