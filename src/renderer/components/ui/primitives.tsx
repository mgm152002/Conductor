import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { XIcon } from './icons';

// Shared UI primitives in the T3 Code idiom: compact controls, hairline
// borders, subtle hover fills, a single accent colour, and visible focus rings.

type Variant = 'default' | 'primary' | 'outline' | 'ghost' | 'destructive' | 'destructive-outline';
type Size = 'xs' | 'sm' | 'md' | 'icon' | 'icon-sm';

const VARIANTS: Record<Variant, string> = {
  default: 'bg-foreground text-background hover:opacity-90',
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  outline: 'border border-border bg-transparent text-foreground hover:bg-accent',
  ghost: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  destructive: 'bg-destructive text-white hover:opacity-90',
  'destructive-outline': 'border border-destructive/30 text-destructive-foreground hover:bg-destructive/10',
};

const SIZES: Record<Size, string> = {
  xs: 'h-6 gap-1 rounded-md px-2 text-2xs',
  sm: 'h-7 gap-1.5 rounded-md px-2.5 text-xs',
  md: 'h-8 gap-2 rounded-lg px-3 text-sm',
  icon: 'size-8 rounded-lg',
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
        'inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-colors',
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
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-3xs font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      {icon !== undefined ? <div className="mb-1 text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description !== undefined ? <p className="max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      {children !== undefined ? <div className="mt-2 flex gap-2">{children}</div> : null}
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
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = panel.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-dialog-close])');
    (focusable ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
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
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cn('relative z-10 w-full rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl outline-none', width)}>
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
}

export const inputClassName = 'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50';
export const textareaClassName = 'w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50';

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
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-45',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform duration-200 ease-drawer', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}
