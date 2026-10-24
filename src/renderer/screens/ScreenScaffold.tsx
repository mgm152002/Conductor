// Page shell for the non-chat screens, matching the T3 Code settings pages: a
// draggable 52px header with the page title, then a centred, scrollable
// content column with a short description.
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
      <header className="app-drag flex h-(--topbar-height) shrink-0 items-center gap-3 border-b border-border px-5">
        <h1 id="screen-title" className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h1>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 pt-6 pb-12">
          <p className="text-sm text-muted-foreground">{description}</p>
          {children !== undefined ? children : (
            <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
              <p>This workspace area is not built yet. It arrives in a later task.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
