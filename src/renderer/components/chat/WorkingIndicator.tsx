import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';

// The status row shown while an agent thinks or works, modelled on Claude
// Code's terminal spinner: a star glyph that grows and shrinks through
// · ✢ ✳ ✶ ✻ ✽ and back, beside a label with a highlight sweeping across it.

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'];
// Forward then back, without repeating the end frames, so it breathes.
const CYCLE = [...FRAMES, ...FRAMES.slice(1, -1).reverse()];
const FRAME_MS = 110;

function SpinnerGlyph(): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setFrame(4); return; }
    const timer = window.setInterval(() => { setFrame((current) => (current + 1) % CYCLE.length); }, FRAME_MS);
    return () => { window.clearInterval(timer); };
  }, []);
  return <span aria-hidden="true" className="cc-glyph">{CYCLE[frame]}</span>;
}

export function WorkingIndicator({ label, elapsed, detail, className }: {
  label: string;
  /** Formatted elapsed time, e.g. "12s". */
  elapsed?: string | undefined;
  /** Quiet trailing text, e.g. "3 agents". */
  detail?: string | undefined;
  className?: string;
}): React.JSX.Element {
  return (
    <div role="status" className={cn('cc-working flex min-w-0 items-baseline gap-2 px-1 text-[13px]', className)}>
      <span className="sr-only">{label}</span>
      <SpinnerGlyph />
      <span aria-hidden="true" className="cc-shimmer">{label}…</span>
      {elapsed !== undefined || detail !== undefined ? (
        <span aria-hidden="true" className="cc-meta tabular-nums">
          ({[elapsed, detail].filter((part) => part !== undefined && part !== '').join(' · ')})
        </span>
      ) : null}
    </div>
  );
}
