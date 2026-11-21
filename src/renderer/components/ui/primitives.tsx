import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { XIcon } from './icons';

// Shared UI primitives, components/ui:
// the same button recipes, sizes and states, so every screen gets the same
// controls without importing its UI kit.

type Variant = 'default' | 'primary' | 'secondary' | 'outline' | 'ghost' | 'ghost-foreground' | 'destructive' | 'destructive-outline';
type Size = 'xs' | 'sm' | 'md' | 'icon' | 'icon-sm' | 'icon-micro';

const BASE = "[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-sm outline-none transition-[box-shadow,scale,background-color,color] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg]:pointer-events-none [&_svg]:shrink-0";

const PRIMARY = 'not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs active:inset-shadow-[0_1px_--theme(--color-black/8%)] disabled:shadow-none active:shadow-none hover:bg-primary/90';

const VARIANTS: Record<Variant, string> = {
  // "default" and "primary" share the one solid action colour.
  default: PRIMARY,
  primary: PRIMARY,
  secondary: 'border-transparent bg-secondary text-foreground hover:bg-secondary/90 active:bg-secondary/80',
  outline: "[--control-icon-color:var(--muted-foreground)] border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 not-disabled:not-active:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:before:shadow-[0_-1px_--theme(--color-white/6%)] disabled:shadow-none active:shadow-none hover:bg-accent/50 dark:hover:bg-input/64",
  // ghost: quiet until hovered.
  ghost: 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  'ghost-foreground': '[--control-icon-color:var(--muted-foreground)] border-transparent text-foreground hover:bg-accent',
  destructive: 'not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs disabled:shadow-none active:shadow-none hover:bg-destructive/90',
  'destructive-outline': 'border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 dark:bg-input/32 disabled:shadow-none active:shadow-none hover:border-destructive/32 hover:bg-destructive/4',
};

const SIZES: Record<Size, string> = {
  xs: "h-6 gap-1 px-[calc(--spacing(2)-1px)] text-xs [&_svg:not([class*='size-'])]:size-3.5",
  sm: "h-7 gap-1.5 px-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4",
  md: "h-8 px-[calc(--spacing(3)-1px)] [&_svg:not([class*='size-'])]:size-4",
  icon: "size-8 [&_svg:not([class*='size-'])]:size-4",
  'icon-sm': "size-6 [&_svg:not([class*='size-'])]:size-3.5",
  'icon-micro': "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'sm', className, type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} data-slot="button" className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...props} />;
});

export function Badge({ children, className, tone = 'neutral' }: { children: ReactNode; className?: string; tone?: 'neutral' | 'success' | 'warning' | 'destructive' | 'info' | 'primary' }): React.JSX.Element {
  const tones = {
    neutral: 'border-input bg-background text-foreground dark:bg-input/32',
    success: 'bg-success/8 text-success dark:bg-success/16',
    warning: 'bg-warning/8 text-warning dark:bg-warning/16',
    destructive: 'bg-destructive/8 text-destructive-foreground dark:bg-destructive/16',
    info: 'bg-info/8 text-info dark:bg-info/16',
    primary: 'bg-primary/10 text-primary dark:bg-primary/16',
  } as const;
  return <span data-slot="badge" className={cn("relative inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-[calc(--spacing(1)-1px)] text-xs font-medium [&_svg:not([class*='size-'])]:size-3 [&_svg]:shrink-0", tones[tone], className)}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd data-slot="kbd" className="pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-foreground/[0.07] px-1 font-sans text-xs font-medium text-muted-foreground">{children}</kbd>;
}

export function Alert({ children, tone = 'destructive', action }: { children: ReactNode; tone?: 'destructive' | 'warning' | 'info'; action?: ReactNode }): React.JSX.Element {
  const tones = {
    destructive: 'border-destructive/25 bg-destructive/6 text-destructive-foreground',
    warning: 'border-warning/25 bg-warning/6 text-warning',
    info: 'border-info/25 bg-info/6 text-info',
  } as const;
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={cn('flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs', tones[tone])}>
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({ title, description, children, icon }: { title: string; description?: ReactNode; children?: ReactNode; icon?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      {icon !== undefined ? <div className="mb-2 text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description !== undefined ? <p className="max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      {children !== undefined ? <div className="mt-3 flex gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * Accessible modal dialog: labelled, Escape to close, focus moved inside on
 * open and restored on close, backdrop click closes.
 */
export function Dialog({ open, onClose, title, description, children, footer, width = 'max-w-md' }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}): React.JSX.Element | null {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass an inline onClose, so its identity changes on every render
  // (e.g. each keystroke in a dialog field). Keep the latest in a ref: if the
  // effect below re-ran on those renders, its cleanup would restore focus to
  // the element focused before the dialog and typing would lose focus after
  // one character.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    // Prefer a text field, so dialogs with inputs open ready to type.
    const focusable = panel.current?.querySelector<HTMLElement>('input:not([type="file"]):not([type="hidden"]), textarea, select')
      ?? panel.current?.querySelector<HTMLElement>('button:not([data-dialog-close])');
    (focusable ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [open ]);
  if (!open) return null;
  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cn('animate-pop-in relative z-10 w-full rounded-xl border border-border bg-surface-raised p-4 text-foreground shadow-pop outline-none', width)}>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
            {description !== undefined ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" data-dialog-close><XIcon size={14} /></Button>
        </div>
        {children}
        {footer !== undefined ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
  // Project threads set `container-type: inline-size` on their layout, which
  // makes it the containing block for fixed-position descendants and traps
  // modals inside the scrolled thread. Portal every dialog to <body> so image
  // previews and confirmations always render above the whole app.
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

export const inputClassName = 'inset-field h-8 w-full px-[calc(--spacing(3)-1px)] text-sm disabled:opacity-64';
export const textareaClassName = 'inset-field w-full px-[calc(--spacing(3)-1px)] py-2 text-sm disabled:opacity-64';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }): React.JSX.Element {
  // Switch: a 16px thumb on a pill that takes the action colour when on.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-slot="switch"
      onClick={() => { onChange(!checked); }}
      className={cn(
        'inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 cursor-pointer items-center rounded-full p-[2px] outline-none transition-[background-color,box-shadow] duration-200 [--thumb-size:--spacing(4)]',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-64',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span className={cn(
        'pointer-events-none block size-[calc(var(--thumb-size)-2px)] shrink-0 rounded-(--thumb-size) bg-background shadow-sm/5 [transition:translate_.15s]',
        checked ? 'translate-x-[calc(var(--thumb-size)-4px)]' : 'dark:bg-muted-foreground',
      )} />
    </button>
  );
}
