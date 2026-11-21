import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

// Settings building blocks, settingsLayout / SettingsGroup
//: a section is a title over a grouped card, a card is a
// stack of rows split by hairlines, a row is a title and description on the
// left with its control on the right.

/** The scrolling page inside the settings modal (readable width). */
export function SettingsPage({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 pt-6 pb-12 sm:px-6">{children}</div>
    </div>
  );
}

export function SettingsSection({ title, action, children, className }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <section className={cn('space-y-2.5', className)}>
      <div className="flex min-h-7 flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 sm:px-4">
        <h2 className="flex min-h-7 items-center gap-2 text-base font-semibold text-foreground">{title}</h2>
        {action !== undefined ? <div className="flex min-h-7 min-w-7 items-center justify-end gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsGroup({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <div data-slot="settings-group" className={cn('relative overflow-visible rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5 *:not-first:border-t *:not-first:border-border/50', className)}>
      {children}
    </div>
  );
}

export function SettingsRow({ title, description, control, children, className }: { title: ReactNode; description?: ReactNode; control?: ReactNode; children?: ReactNode; className?: string }): React.JSX.Element {
  return (
    <div data-slot="settings-row" className={cn('group/settings-row @container/settings-row px-3 sm:px-4', children !== undefined ? 'pt-3 pb-1' : 'py-3', className)}>
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          </div>
          {description !== undefined ? <p className="max-w-2xl text-pretty text-xs leading-normal text-muted-foreground">{description}</p> : null}
        </div>
        {control !== undefined ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">{control}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
