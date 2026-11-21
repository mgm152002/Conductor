import type { UsageRange, UsageSummary } from '@shared/usage';
import { UsageOverview } from './UsageOverview';

// The Cost view: Usage layout (see UsageOverview), by cost.
// Cost is estimated from recorded tokens at each model's public models.dev
// price; harness-reported cost is never used.

export interface UsageCostViewProps {
  summary: UsageSummary;
  range?: UsageRange;
  loading?: boolean;
}

export function UsageCostView({ summary, loading = false }: UsageCostViewProps): React.JSX.Element {
  return <UsageOverview summary={summary} metric="cost" loading={loading} />;
}
