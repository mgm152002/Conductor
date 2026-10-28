// Shared chrome for an inspection region (plan, checks, files, context,
// activity). Rendered flat inside the thread details panel: a small heading
// row with an optional count and subtitle, then content or an empty label.
interface RegionCardProps {
  title: string;
  subtitle?: string;
  /** Count badge shown next to the title. */
  count?: number;
  /** Optional control (for example a refresh button) shown in the header. */
  action?: React.ReactNode;
  /** Rendered when there is nothing to show yet. */
  emptyLabel: string;
  /** Whether the region currently has content. */
  isEmpty: boolean;
  /** Render content without the grouped-card wrapper (the content brings its own single container). */
  bare?: boolean;
  children?: React.ReactNode;
}

export function RegionCard({ title, subtitle, count, action, emptyLabel, isEmpty, bare = false, children }: RegionCardProps): React.JSX.Element {
  return (
    <section className="flex min-h-0 min-w-0 flex-col [overflow-wrap:anywhere]" aria-label={title}>
      <header className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
          {count !== undefined && count > 0 ? (
            <span className="rounded-full bg-accent px-1.5 text-3xs font-medium text-muted-foreground tabular-nums">{count}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {subtitle !== undefined ? <p className="text-2xs text-muted-foreground">{subtitle}</p> : null}
          {action}
        </div>
      </header>
      {bare ? (
        <div className="min-h-0 flex-1">
          {isEmpty ? <p className="py-2 text-xs text-muted-foreground/80">{emptyLabel}</p> : children}
        </div>
      ) : (
        <div className="group-card min-h-0 flex-1 px-3 py-2.5">
          {isEmpty ? <p className="py-2 text-xs text-muted-foreground/80">{emptyLabel}</p> : children}
        </div>
      )}
    </section>
  );
}
