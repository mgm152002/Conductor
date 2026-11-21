import type { UsageRange, UsageSummary } from '@shared/usage';
import { UsageOverview } from './UsageOverview';

// The Tokens view: Usage layout (see UsageOverview), by tokens.
// Cost is estimated from recorded tokens at each model's public models.dev
// price; harness-reported cost is never used.

export interface UsageTokensViewProps {
  summary: UsageSummary;
  range?: UsageRange;
  loading?: boolean;
}

export function UsageTokensView({ summary, loading = false }: UsageTokensViewProps): React.JSX.Element {
  return <UsageOverview summary={summary} metric="tokens" loading={loading} />;
}
