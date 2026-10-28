import type { UsageLimitWindow } from '@shared/usage';
import { cn } from '../../lib/cn';
import { percentLeft, resetCountdown } from '../../lib/usage-format';
import { Badge } from '../ui/primitives';
import { RotateIcon } from '../ui/icons';

// One Session, Daily, or Weekly quota window for an attached CLI
// (Requirement 2.3).
//
// The percentage is only rendered when the CLI actually reported it. A missing
// sample shows a quiet "Not reported" state over a dashed track instead of
// inventing 0% (Requirement 4.4) — and, importantly, it no longer repeats the
// CLI name inside an empty bar. A window can still be known without a
// percentage (OpenCode's free tier only reports one after its limit is hit);
// that state keeps the real reset countdown and says the percentage is
// unreported. The progress bar is a real `progressbar` with min/max/now values
// so assistive technology can announce the remaining percentage
// (Requirement 2.5).

export interface UsageLimitCardProps {
  /** "Session", "Daily", or "Weekly". */
  title: string;
  /** The display name of the CLI this window belongs to. */
  clientLabel: string;
  /** The reported window, or undefined when the CLI reports no limits. */
  limit?: UsageLimitWindow | undefined;
  /** Injectable clock so tests get deterministic countdowns. */
  now?: Date | number;
  className?: string;
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
  const tracked = limit !== undefined && !reported;
  const label = limit?.label;
  const ariaLabel = `${clientLabel} ${label !== undefined ? `${label} ` : ''}${title.toLowerCase()} limit`;

  return (
    <div className={cn('group-card flex items-center gap-4 px-4 py-3', className)}>
      <div className="w-36 shrink-0">
        <p className="text-[13px] text-foreground">
          {title}
          {label !== undefined ? <span className="block truncate text-3xs text-muted-foreground">{label}</span> : null}
        </p>
        {reported ? (
          <p className="mt-0.5 flex items-baseline gap-1">
            <span className="text-[22px] leading-none font-medium text-foreground tabular-nums">{percent}%</span>
            <span className="text-2xs text-muted-foreground">left</span>
          </p>
        ) : (
          <p className="mt-0.5 text-2xs font-medium text-muted-foreground">{tracked ? 'Not reported' : 'Not reported by this CLI'}</p>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {reported ? (
          <div
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}% left`}
            className="limit-track"
          >
            <div className="limit-fill" style={{ width: `${percent}%` }} aria-hidden="true" />
            <span className="absolute inset-y-0 left-2 flex items-center text-3xs font-medium text-foreground/80 tabular-nums">{percent}%</span>
            {reset !== undefined ? (
              <span className="absolute inset-y-0 right-1.5 flex items-center gap-1 rounded bg-black/25 px-1.5 text-3xs text-foreground/85 tabular-nums">
                <RotateIcon size={9} aria-hidden="true" />{reset}
              </span>
            ) : null}
          </div>
        ) : (
          <div
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={tracked ? 'Remaining percentage not reported' : 'Not reported by this CLI'}
            className="limit-track opacity-60"
          >
            <span className="absolute inset-y-0 left-2 flex items-center text-3xs text-muted-foreground">
              {tracked ? 'Remaining percentage not reported' : `No ${title.toLowerCase()} quota window has been reported.`}
            </span>
            {reset !== undefined ? (
              <span className="absolute inset-y-0 right-1.5 flex items-center gap-1 rounded bg-black/25 px-1.5 text-3xs text-foreground/85 tabular-nums">
                <RotateIcon size={9} aria-hidden="true" />{reset}
              </span>
            ) : null}
          </div>
        )}
      </div>
      {reported ? <Badge tone={badgeTone(percent)} className="hidden shrink-0 sm:inline-flex">{percent}% left</Badge> : null}
    </div>
  );
}
