// Page shell for the non-chat screens, in the T3 shape: a quiet draggable
// header with a breadcrumb-style title, then a centred scrollable column
// where content sits in grouped cards on the canvas.
interface ScreenScaffoldProps {
  title: string;
  description: string;
  /** Optional controls rendered at the right of the header. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

export function ScreenScaffold({ title, description, actions, children }: ScreenScaffoldProps): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-labelledby="screen-title">
      <header className="app-drag flex h-(--topbar-height) shrink-0 items-center gap-3 px-5">
        <h1 id="screen-title" className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h1>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-6 pt-5 pb-14">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
          {children !== undefined ? children : (
            <div className="group-card px-6 py-10 text-center text-sm text-muted-foreground">
              <p>This workspace area is not built yet. It arrives in a later task.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
