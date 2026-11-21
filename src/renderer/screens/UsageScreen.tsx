import { useState } from 'react';
import type { UsageRange, UsageSummary } from '@shared/usage';
import { UsageCostView } from '../components/usage/UsageCostView';
import { UsageHeader, type UsageView } from '../components/usage/UsageHeader';
import { UsageLimitsView } from '../components/usage/UsageLimitsView';
import { UsageTokensView } from '../components/usage/UsageTokensView';
import { Alert, Button, EmptyState } from '../components/ui/primitives';
import { useUsageOverview } from '../hooks/useUsageOverview';
import { AppRouteModal, AppRouteModalClose } from '../components/ui/AppRouteModal';

// The Usage destination (Requirement 2.1). `UsageScreen` owns the selected
// view/range and the bridge request; `UsageScreenView` is a pure render of that
// state so renderer tests can exercise every state without the preload bridge.
// The active view receives the same overview props (summary, range, loading,
// error, view) so each can render its own breakdown and empty states.
//
// The Cost/Tokens/Limits bodies live in `components/usage` (tasks 3.2/3.3);
// this shell only owns the header, range selection, and data lifecycle.

// A month by default: a week routinely hides a CLI that was used last week.
const DEFAULT_RANGE: UsageRange = '30d';
const DEFAULT_VIEW: UsageView = 'cost';

export interface UsageScreenViewProps {
  summary: UsageSummary | null;
  loading?: boolean;
  error?: string | null;
  view: UsageView;
  range: UsageRange;
  onViewChange?: (view: UsageView) => void;
  onRangeChange?: (range: UsageRange) => void;
  onRefresh?: () => void;
  /** Set inside the route modal: shows the close button. */
  onClose?: () => void;
}

const noop = (): void => {};

function ActiveView({
  view,
  summary,
  loading,
  error,
  range,
}: {
  view: UsageView;
  summary: UsageSummary;
  loading: boolean;
  error: string | null;
  range: UsageRange;
}): React.JSX.Element {
  // Spread keeps the child contract structural: each view may consume any
  // subset of the overview props it needs.
  const props = { summary, loading, error, range, view };
  switch (view) {
    case 'tokens':
      return <UsageTokensView {...props} />;
    case 'limits':
      return <UsageLimitsView {...props} />;
    case 'cost':
    default:
      return <UsageCostView {...props} />;
  }
}

export function UsageScreenView({
  summary,
  loading = false,
  error = null,
  view,
  range,
  onViewChange = noop,
  onRangeChange = noop,
  onRefresh = noop,
  onClose,
}: UsageScreenViewProps): React.JSX.Element {
  // Usage modal: a "Usage" breadcrumb header with the view switch,
  // refresh and close at the right; the body in the readable column.
  return (
    <section data-screen="usage" aria-labelledby="usage-title" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border ps-5 pe-2">
        <h1 id="usage-title" className="text-sm font-medium text-foreground">Usage</h1>
        <div className="ms-auto flex min-w-0 items-center gap-1">
          <UsageHeader
            view={view}
            range={range}
            loading={loading}
            onViewChange={onViewChange}
            onRangeChange={onRangeChange}
            onRefresh={onRefresh}
          />
          {onClose !== undefined ? <AppRouteModalClose onClose={onClose} /> : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 pt-6 pb-12 sm:px-6">
      {error !== null ? (
        <Alert
          action={(
            <Button size="xs" variant="ghost" onClick={onRefresh}>
              Retry
            </Button>
          )}
        >
          {error}
        </Alert>
      ) : null}

      {summary !== null ? (
        <ActiveView view={view} summary={summary} loading={loading} error={error} range={range} />
      ) : loading ? (
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          Loading usage…
        </p>
      ) : error === null ? (
        <EmptyState
          title="No usage recorded yet"
        />
      ) : null}
      </div>
      </div>
    </section>
  );
}

export function UsageScreen({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const [view, setView] = useState<UsageView>(DEFAULT_VIEW);
  const [range, setRange] = useState<UsageRange>(DEFAULT_RANGE);
  const { summary, loading, error, refresh } = useUsageOverview(range);

  const close = onClose ?? ((): void => { window.history.back(); });
  return (
    <AppRouteModal label="Usage" onClose={close}>
    <UsageScreenView
      onClose={close}
      summary={summary}
      loading={loading}
      error={error}
      view={view}
      range={range}
      onViewChange={setView}
      onRangeChange={setRange}
      onRefresh={refresh}
    />
    </AppRouteModal>
  );
}
