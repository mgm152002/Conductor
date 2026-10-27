import type { UsageRange } from '@shared/usage';
import { cn } from '../../lib/cn';
import { USAGE_RANGES } from '../../lib/usage-format';
import { RotateIcon, Spinner } from '../ui/icons';
import { Button } from '../ui/primitives';

// The Usage screen header controls: a Cost/Tokens/Limits segmented control, the
// four range chips, and a refresh action. Every control is a native button, so
// Tab + Enter/Space and the shared focus ring make the header keyboard
// accessible (Requirement 2.1, 2.5).

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
      <div
        role="group"
        aria-label="Usage view"
        className="flex shrink-0 items-center gap-0.5 rounded-lg bg-accent p-0.5"
      >
        {USAGE_VIEWS.map((entry) => {
          const selected = entry.id === view;
          return (
            <Button
              key={entry.id}
              size="xs"
              variant={selected ? 'default' : 'ghost'}
              aria-pressed={selected}
              onClick={() => { onViewChange(entry.id); }}
              className={cn('rounded-md', selected && 'shadow-xs')}
            >
              {entry.label}
            </Button>
          );
        })}
      </div>

      <div role="group" aria-label="Usage range" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {USAGE_RANGES.map((entry) => {
          const selected = entry.id === range;
          return (
            <Button
              key={entry.id}
              size="xs"
              variant="ghost"
              aria-pressed={selected}
              onClick={() => { onRangeChange(entry.id); }}
              className={cn(selected && 'bg-accent text-foreground')}
            >
              {entry.label}
            </Button>
          );
        })}
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
