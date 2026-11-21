// Page shell for the non-thread screens: a thin header with the title and the
// screen's controls, and a scrolling content column below it.
interface ScreenScaffoldProps {
  title: string;
  /** Kept for call sites; not shown. Screens say what they are through their content. */
  description?: string;
  /** Optional controls at the right of the header. */
  actions?: React.ReactNode;
  /** Kept for call sites; not shown. */
  icon?: React.ReactNode;
  /** Content width: narrative screens stay narrow, boards and desks open up. */
  layout?: 'ledger' | 'wide' | 'dashboard' | 'workbench';
  /** Stable screen id, exposed as data-screen for per-screen styling. */
  screen?: string;
  children?: React.ReactNode;
}

const LAYOUTS = {
  // WorkspacePageContainer widths: readable, wide, expanded.
  ledger: 'max-w-4xl',
  wide: 'max-w-4xl',
  dashboard: 'max-w-5xl',
  workbench: 'max-w-[84rem]',
} as const;

export function ScreenScaffold({ title, actions, layout = 'ledger', screen, children }: ScreenScaffoldProps): React.JSX.Element {
  return (
    <section data-screen={screen} className="flex h-full min-h-0 flex-col bg-background" aria-labelledby="screen-title">
      <header className="window-header flex shrink-0 items-center gap-3 border-b border-border px-5">
        <h1 id="screen-title" className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{title}</h1>
        {actions !== undefined ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto flex w-full ${LAYOUTS[layout]} flex-col gap-8 px-5 pt-6 pb-12 sm:px-6`}>
          {children !== undefined ? children : <p className="py-10 text-center text-sm text-muted-foreground">Not built yet.</p>}
        </div>
      </div>
    </section>
  );
}
