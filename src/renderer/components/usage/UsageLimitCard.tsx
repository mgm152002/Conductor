import type { UsageLimitWindow } from '@shared/usage';
import { cn } from '../../lib/cn';
import { percentLeft, resetCountdown } from '../../lib/usage-format';
import { RotateIcon } from '../ui/icons';

// One reported Session, Daily, or Weekly quota window for an attached CLI
// (Requirement 2.3). Only reported windows are rendered at all — there is no
// placeholder card or bar for a window the CLI did not report.
//
// The bar is only rendered when the CLI actually reported a percentage, and
// it is a real `progressbar` with min/max/now values so assistive technology
// can announce the remaining percentage (Requirement 2.5). A window can still
// be known without a percentage (OpenCode's free tier only reports one after
// its limit is hit); that state shows the reset countdown as plain text
// instead of a bar, rather than inventing 0% (Requirement 4.4).

export interface UsageLimitCardProps {
  /** "Session", "Daily", or "Weekly". */
  title: string;
  /** The display name of the CLI this window belongs to. */
  clientLabel: string;
  /** The reported window; unreported windows are not rendered. */
  limit: UsageLimitWindow;
  /** Injectable clock so tests get deterministic countdowns. */
  now?: Date | number;
  className?: string;
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
  const label = limit.label;
  const ariaLabel = `${clientLabel} ${label !== undefined ? `${label} ` : ''}${title.toLowerCase()} limit`;

  // How far through the window we are, as a tick on the bar (a pace marker).
  const resetsAt = limit.resetsAt !== undefined ? Date.parse(limit.resetsAt) : NaN;
  const windowMs = (limit.windowMinutes ?? 0) * 60_000;
  const timeLeft = Number.isFinite(resetsAt) && windowMs > 0 ? Math.min(1, Math.max(0, (resetsAt - (typeof now === 'number' ? now : now.getTime())) / windowMs)) : undefined;

  // Limit row: the window and a large "% left" at the left, a tall
  // bar at the right, solid for what is left and hatched for what is used.
  return (
    <div className={cn('flex items-center gap-6 rounded-xl border border-border/60 bg-card/40 px-6 py-5 shadow-xs/5', className)}>
      <div className="w-56 shrink-0">
        <p className="text-sm text-foreground">
          {title}
          {label !== undefined ? <span className="ms-1.5 text-muted-foreground">{label}</span> : null}
        </p>
        {percent !== undefined ? (
          <p className="mt-1 flex items-baseline gap-1.5">
            <span className="text-4xl font-medium tracking-tight text-foreground tabular-nums">{percent}%</span>
            <span className="text-sm text-muted-foreground">left</span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Remaining percentage not reported</p>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {percent !== undefined ? (
          <div
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}% left`}
            className="limit-track relative h-11 overflow-hidden rounded-lg border-0"
            style={{ background: 'repeating-linear-gradient(135deg, color-mix(in oklab, var(--primary) 22%, var(--background)) 0 2px, color-mix(in oklab, var(--primary) 32%, var(--background)) 2px 6px)' }}
          >
            <div className="absolute inset-y-0 left-0 rounded-lg" style={{ width: `${percent}%`, background: 'color-mix(in oklab, var(--primary) 48%, var(--background))' }} aria-hidden="true" />
            {timeLeft !== undefined ? <span aria-hidden className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-foreground ring-2 ring-background" style={{ left: `${timeLeft * 100}%` }} /> : null}
            {reset !== undefined ? (
              <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 rounded-md bg-background/85 px-1.5 py-0.5 text-xs text-foreground tabular-nums">
                <RotateIcon size={11} aria-hidden="true" />{reset}
              </span>
            ) : null}
          </div>
        ) : reset !== undefined ? (
          <p className="flex items-center gap-1 text-sm text-muted-foreground tabular-nums">
            <RotateIcon size={11} aria-hidden="true" />Resets in {reset}
          </p>
        ) : null}
      </div>
    </div>
  );
}
