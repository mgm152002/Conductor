import type { UsageLimitWindow } from '@shared/usage';
import { cn } from '../../lib/cn';
import { percentLeft, resetCountdown } from '../../lib/usage-format';
import { Badge } from '../ui/primitives';
import { RotateIcon } from '../ui/icons';

// One Session or Weekly quota window for an attached CLI (Requirement 2.3).
//
// The percentage is only rendered when the CLI actually reported it. A missing
// sample shows a quiet "Not reported" state over a dashed track instead of
// inventing 0% (Requirement 4.4) — and, importantly, it no longer repeats the
// CLI name inside an empty bar. The progress bar is a real `progressbar` with
// min/max/now values so assistive technology can announce the remaining
// percentage (Requirement 2.5).

export interface UsageLimitCardProps {
  /** "Session" or "Weekly". */
  title: string;
  /** The display name of the CLI this window belongs to. */
  clientLabel: string;
  /** The reported window, or undefined when the CLI reports no limits. */
  limit?: UsageLimitWindow | undefined;
  /** Injectable clock so tests get deterministic countdowns. */
  now?: Date | number;
  className?: string;
}

/** Fill colour by remaining percentage: healthy, low, or nearly exhausted. */
function remainingTone(percent: number): string {
  if (percent >= 50) return 'bg-success';
  if (percent >= 20) return 'bg-warning';
  return 'bg-destructive';
}

/** Badge tone that mirrors the bar colour. */
function badgeTone(percent: number): 'success' | 'warning' | 'destructive' {
  if (percent >= 50) return 'success';
  if (percent >= 20) return 'warning';
  return 'destructive';
}

export function UsageLimitCard({
  title,
  clientLabel,
  limit,
  now = Date.now(),
  className,
}: UsageLimitCardProps): React.JSX.Element {
  const percent = percentLeft(limit);
  // `resetCountdown` returns undefined for absent, invalid, or already-passed
  // reset times, so expired windows simply omit the countdown.
  const reset = resetCountdown(limit, now);
  const reported = percent !== undefined;
  const ariaLabel = `${clientLabel} ${title.toLowerCase()} limit`;

  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5', className)}>
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <Badge tone={reported ? badgeTone(percent) : 'neutral'} className="ml-auto">
          {reported ? `${percent}% left` : 'Not reported'}
        </Badge>
      </div>

      {reported ? (
        <>
          <p className="flex items-baseline gap-1.5">
            <span className="text-2xl leading-none font-semibold text-foreground tabular-nums">{percent}%</span>
            <span className="text-2xs text-muted-foreground">left</span>
          </p>
          <div
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}% left`}
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted/70"
          >
            <div
              className={cn('h-full rounded-full transition-[width]', remainingTone(percent))}
              style={{ width: `${percent}%` }}
              aria-hidden="true"
            />
          </div>
          <p className="flex min-h-4 items-center gap-1 text-3xs text-muted-foreground">
            {reset !== undefined ? (
              <>
                <RotateIcon size={10} aria-hidden="true" />
                <span>Resets in {reset}</span>
              </>
            ) : (
              <span>Current window</span>
            )}
          </p>
        </>
      ) : (
        <>
          <div
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext="Not reported by this CLI"
            className="h-2.5 w-full overflow-hidden rounded-full border border-dashed border-border/80 bg-muted/30"
          />
          <p className="text-2xs font-medium text-muted-foreground">Not reported by this CLI</p>
          <p className="text-3xs text-muted-foreground/80">
            This CLI does not publish a {title.toLowerCase()} quota window.
          </p>
        </>
      )}
    </div>
  );
}
