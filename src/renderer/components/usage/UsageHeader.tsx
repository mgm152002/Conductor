import type { UsageRange } from '@shared/usage';
import { USAGE_RANGES } from '../../lib/usage-format';
import { RotateIcon, Spinner } from '../ui/icons';
import { Button } from '../ui/primitives';

// The Usage screen header controls, in the T3 shape: two pill segmented
// controls (view, then range) floating at the top-right, plus a refresh
// action. Every control is a native button for keyboard access.

export type UsageView = 'cost' | 'tokens' | 'limits';

export const USAGE_VIEWS: { id: UsageView; label: string }[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'limits', label: 'Limits' },
];

export interface UsageHeaderProps {
  view: UsageView;
  range: UsageRange;
  loading?: boolean;
  onViewChange: (view: UsageView) => void;
  onRangeChange: (range: UsageRange) => void;
  onRefresh: () => void;
}

export function UsageHeader({
  view,
  range,
  loading = false,
  onViewChange,
  onRangeChange,
  onRefresh,
}: UsageHeaderProps): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div role="group" aria-label="Usage view" className="seg-control shrink-0">
        {USAGE_VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-active={entry.id === view}
            aria-pressed={entry.id === view}
            onClick={() => { onViewChange(entry.id); }}
            className="seg-item focus-visible:outline-2 focus-visible:outline-ring"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div role="group" aria-label="Usage range" className="seg-control min-w-0 overflow-x-auto">
        {USAGE_RANGES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-active={entry.id === range}
            aria-pressed={entry.id === range}
            onClick={() => { onRangeChange(entry.id); }}
            className="seg-item focus-visible:outline-2 focus-visible:outline-ring"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={loading ? 'Refreshing usage' : 'Refresh usage'}
        aria-busy={loading}
        disabled={loading}
        onClick={onRefresh}
      >
        {loading ? <Spinner size={13} /> : <RotateIcon size={14} />}
      </Button>
    </div>
  );
}
