import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { CheckIcon, ChevronDownIcon, SearchIcon } from './icons';

// A select that renders its options as a real menu (logos, subtitles,
// disabled rows) instead of the OS-native dropdown. The menu is portalled
// to <body> with fixed positioning so it is never clipped by the
// composer's scroll area; it flips above the trigger when space runs out.

export interface MenuOption {
  value: string;
  label: string;
  /** Small line under the label, e.g. a tier note. */
  hint?: string;
  /** Leading visual, usually a <BrandMark>. */
  mark?: React.ReactNode;
  disabled?: boolean;
}

export function MenuSelect({ value, options, onChange, label, disabled, variant = 'pill', className, title, searchable = false }: {
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  /** Accessible name for the trigger and menu. */
  label: string;
  disabled?: boolean | undefined;
  variant?: 'pill' | 'box';
  className?: string | undefined;
  title?: string | undefined;
  /** Show a filter input at the top of the menu (long model lists). */
  searchable?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const visible = query === '' ? options : options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
  const [pos, setPos] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) ?? options[0];

  const place = (): void => {
    const el = trigger.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const menuHeight = Math.min(options.length * 36 + 8, 288) + (searchable ? 37 : 0);
    const above = rect.bottom + menuHeight + 8 > window.innerHeight && rect.top > menuHeight + 8;
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 200) - 8)),
      top: above ? rect.top - 4 : rect.bottom + 4,
      width: Math.max(rect.width, 200),
      above,
    });
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (trigger.current?.contains(event.target as Node) || menu.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    const onScroll = (): void => { place(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    if (searchable) menu.current?.querySelector<HTMLElement>('input')?.focus();
    else menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const pick = (option: MenuOption): void => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onClick={() => { setQuery(''); setOpen((v) => !v); }}
        className={cn(
          'flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-1.5 text-xs whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:cursor-default disabled:opacity-60',
          variant === 'pill'
            ? 'rounded-md pr-1.5 pl-2 text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'h-8 w-full rounded-md border border-border bg-transparent px-2 text-foreground hover:border-border-strong',
          className,
        )}
      >
        {selected?.mark !== undefined ? <span className="flex shrink-0 items-center text-foreground/80">{selected.mark}</span> : null}
        <span className="min-w-0 truncate">{selected?.label ?? value}</span>
        <ChevronDownIcon size={11} className={cn('shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && pos !== null && typeof document !== 'undefined' ? createPortal(
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          style={{ left: pos.left, width: pos.width, ...(pos.above ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
          className="animate-pop-in fixed z-50 flex max-h-80 flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-raised shadow-xl"
        >
          {searchable ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-2">
              <SearchIcon size={13} className="shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => { setQuery(event.target.value); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); const first = visible.find((o) => !o.disabled); if (first !== undefined) pick(first); }
                }}
                placeholder={`Search ${label.toLowerCase()}…`}
                aria-label={`Search ${label.toLowerCase()}`}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
              {query !== '' ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); }} className="shrink-0 cursor-pointer text-xs text-muted-foreground hover:text-foreground">✕</button> : null}
            </div>
          ) : null}
          <div className="min-h-0 overflow-y-auto p-1">
          {visible.length === 0 ? <p className="px-2 py-3 text-xs text-muted-foreground">No matches</p> : null}
          {visible.map((option) => (
            <button
              key={option.value || '__auto__'}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              disabled={option.disabled}
              onClick={() => { pick(option); }}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-45',
                option.value === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {option.mark !== undefined ? <span className="flex w-4 shrink-0 items-center justify-center text-foreground/85">{option.mark}</span> : <span className="w-4 shrink-0" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.hint !== undefined ? <span className="block truncate text-3xs text-muted-foreground">{option.hint}</span> : null}
              </span>
              {option.value === value ? <CheckIcon size={12} className="shrink-0 text-primary" /> : null}
            </button>
          ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
