// Page shell for the non-chat screens: a draggable header ruled like the
// top of a ledger page — serif title with the punch-red entry mark — then a
// centred scrollable column where content sits in grouped cards.
interface ScreenScaffoldProps {
  title: string;
  /** One short line under the title. Omit it — most screens don't need it. */
  description?: string;
  /** Optional controls rendered at the right of the header. */
  actions?: React.ReactNode;
  /** Stamped icon tile in the header; identifies the screen at a glance. */
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
    <section data-screen={screen} className="flex h-full min-h-0 flex-col bg-background" aria-labelledby="screen-title">
      <header className="app-drag flex h-(--topbar-height) shrink-0 items-center gap-3 border-b border-border px-5">
        {icon !== undefined ? (
          <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-[2px_2px_0_0_var(--shadow-hard-color)]">{icon}</span>
        ) : (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />
        )}
        <h1 id="screen-title" className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold text-foreground">{title}</h1>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto flex w-full ${LAYOUTS[layout]} flex-col gap-5 px-5 pt-4 pb-10`}>
          {description !== undefined ? <p className="text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
          {children !== undefined ? children : (
            <div className="group-card px-6 py-10 text-center text-sm text-muted-foreground">
              <p>Not built yet.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
