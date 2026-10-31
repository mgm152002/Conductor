import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { XIcon } from './icons';

// Shared UI primitives in the dispatch-ledger idiom: squared ticket-stub
// controls, hairline borders, punch red for the primary action (with a hard
// offset shadow so it reads as stamped, not floating), and visible focus rings.

type Variant = 'default' | 'primary' | 'outline' | 'ghost' | 'destructive' | 'destructive-outline';
type Size = 'xs' | 'sm' | 'md' | 'icon' | 'icon-sm';

const VARIANTS: Record<Variant, string> = {
  default: 'bg-foreground text-background hover:opacity-90',
  primary: 'bg-primary text-primary-foreground shadow-[2px_2px_0_0_var(--shadow-hard-color)] hover:brightness-110',
  outline: 'border border-border bg-card text-foreground shadow-xs hover:bg-accent',
  ghost: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  destructive: 'bg-destructive text-white hover:opacity-90',
  'destructive-outline': 'border border-destructive/30 text-destructive-foreground hover:bg-destructive/10',
};

const SIZES: Record<Size, string> = {
  xs: 'h-6 gap-1 rounded-md px-2.5 text-2xs',
  sm: 'h-7 gap-1.5 rounded-md px-3 text-xs',
  md: 'h-8 gap-2 rounded-md px-3.5 text-sm',
  icon: 'size-8 rounded-md',
  'icon-sm': 'size-6 rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'sm', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-[color,background-color,border-color,filter,transform] duration-150 active:scale-[0.97]',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

export function Badge({ children, className, tone = 'neutral' }: { children: ReactNode; className?: string; tone?: 'neutral' | 'success' | 'warning' | 'destructive' | 'info' | 'primary' }): React.JSX.Element {
  const tones = {
    neutral: 'border-border text-muted-foreground',
    success: 'border-success/25 bg-success/8 text-success',
    warning: 'border-warning/25 bg-warning/8 text-warning',
    destructive: 'border-destructive/25 bg-destructive/8 text-destructive-foreground',
    info: 'border-info/25 bg-info/8 text-info',
    primary: 'border-primary/25 bg-primary/10 text-primary',
  } as const;
  return <span className={cn('inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-3xs font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border px-1 font-sans text-3xs text-muted-foreground">{children}</kbd>;
}

export function Alert({ children, tone = 'destructive', action }: { children: ReactNode; tone?: 'destructive' | 'warning' | 'info'; action?: ReactNode }): React.JSX.Element {
  const tones = {
    destructive: 'border-destructive/25 bg-destructive/6 text-destructive-foreground',
    warning: 'border-warning/25 bg-warning/6 text-warning',
    info: 'border-info/25 bg-info/6 text-info',
  } as const;
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={cn('flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-xs', tones[tone])}>
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({ title, description, children, icon }: { title: string; description?: ReactNode; children?: ReactNode; icon?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-14 text-center">
      {icon !== undefined ? <div className="mb-2 flex size-11 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-[3px_3px_0_0_var(--shadow-hard-color)]">{icon}</div> : null}
      <p className="font-display text-lg font-semibold text-foreground">{title}</p>
      {description !== undefined ? <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
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
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cn('animate-pop-in relative z-10 w-full rounded-xl border border-border bg-surface-raised p-5 text-foreground shadow-2xl outline-none', width)}>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="font-display text-base font-semibold">{title}</h2>
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

export const inputClassName = 'inset-field h-8 w-full px-2.5 text-sm placeholder:text-muted-foreground/70 disabled:opacity-50';
export const textareaClassName = 'inset-field w-full px-2.5 py-2 text-sm placeholder:text-muted-foreground/70 disabled:opacity-50';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => { onChange(!checked); }}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-45',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span className={cn('inline-block size-5 rounded-full bg-white shadow transition-transform duration-200 ease-drawer', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
    </button>
  );
}
