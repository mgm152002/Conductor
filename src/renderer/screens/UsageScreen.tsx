import { useState } from 'react';
import type { UsageRange, UsageSummary } from '@shared/usage';
import { UsageCostView } from '../components/usage/UsageCostView';
import { UsageHeader, type UsageView } from '../components/usage/UsageHeader';
import { UsageLimitsView } from '../components/usage/UsageLimitsView';
import { UsageTokensView } from '../components/usage/UsageTokensView';
import { Alert, Button, EmptyState } from '../components/ui/primitives';
import { useUsageOverview } from '../hooks/useUsageOverview';
import { ScreenScaffold } from './ScreenScaffold';

// The Usage destination (Requirement 2.1). `UsageScreen` owns the selected
// view/range and the bridge request; `UsageScreenView` is a pure render of that
// state so renderer tests can exercise every state without the preload bridge.
// The active view receives the same overview props (summary, range, loading,
// error, view) so each can render its own breakdown and empty states.
//
// The Cost/Tokens/Limits bodies live in `components/usage` (tasks 3.2/3.3);
// this shell only owns the header, range selection, and data lifecycle.

const DEFAULT_RANGE: UsageRange = '7d';
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
}: UsageScreenViewProps): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Usage"
      description="Cost, token, and limit breakdowns reported by each attached agent CLI."
      actions={(
        <UsageHeader
          view={view}
          range={range}
          loading={loading}
          onViewChange={onViewChange}
          onRangeChange={onRangeChange}
          onRefresh={onRefresh}
        />
      )}
    >
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
          description="Usage appears here after an attached agent CLI runs a session."
        />
      ) : null}
    </ScreenScaffold>
  );
}

export function UsageScreen(): React.JSX.Element {
  const [view, setView] = useState<UsageView>(DEFAULT_VIEW);
  const [range, setRange] = useState<UsageRange>(DEFAULT_RANGE);
  const { summary, loading, error, refresh } = useUsageOverview(range);

  return (
    <UsageScreenView
      summary={summary}
      loading={loading}
      error={error}
      view={view}
      range={range}
      onViewChange={setView}
      onRangeChange={setRange}
      onRefresh={refresh}
    />
  );
}
