// Page shell for the non-thread screens. The top bar already says where you
// are, so a screen has no title bar of its own: it opens with a large title
// in the display face (and its controls beside it) at the head of a centred
// scrolling column, and the content follows in grouped cards.
interface ScreenScaffoldProps {
  title: string;
  /** One short line under the title. Omit it — most screens don't need it. */
  description?: string;
  /** Optional controls rendered at the right of the header. */
  actions?: React.ReactNode;
  /** Glyph beside the title; identifies the screen at a glance. */
  icon?: React.ReactNode;
  /** Content width: narrative screens stay narrow, boards and desks open up. */
  layout?: 'ledger' | 'wide' | 'dashboard' | 'workbench';
  /** Stable screen id, exposed as data-screen for per-screen styling. */
  screen?: string;
  children?: React.ReactNode;
}

const LAYOUTS = {
  ledger: 'max-w-3xl',
  wide: 'max-w-6xl',
  dashboard: 'max-w-7xl',
  workbench: 'max-w-[88rem]',
} as const;

export function ScreenScaffold({ title, description, actions, icon, layout = 'ledger', screen, children }: ScreenScaffoldProps): React.JSX.Element {
  return (
    <section data-screen={screen} className="h-full min-h-0 overflow-y-auto bg-background" aria-labelledby="screen-title">
      <div className={`mx-auto flex w-full ${LAYOUTS[layout]} flex-col gap-6 px-8 pt-9 pb-14`}>
        <header className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <h1 id="screen-title" className="flex items-center gap-2.5 font-display text-[26px] leading-tight font-semibold text-foreground">
              {icon !== undefined ? <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/14 text-primary">{icon}</span> : null}
              {title}
            </h1>
            {description !== undefined ? <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
          </div>
          {actions !== undefined ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
        {children !== undefined ? children : (
          <div className="group-card px-6 py-10 text-center text-sm text-muted-foreground">
            <p>Not built yet.</p>
          </div>
        )}
      </div>
    </section>
  );
}
