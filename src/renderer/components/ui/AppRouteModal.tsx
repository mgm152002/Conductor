import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from './icons';
import { Button } from './primitives';

// The large modal Settings and Usage open in, AppRouteModal
//: the page that opened it stays behind a blurred
// backdrop; Esc, the close button or a press on the backdrop goes back to it.

export function AppRouteModal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }): React.JSX.Element {
  const popup = useRef<HTMLDivElement>(null);
  const backdropPress = useRef(false);
  const [closing, setClosing] = useState(false);
  const [shown, setShown] = useState(false);

  const close = (): void => {
    if (closing) return;
    // Commit-on-blur fields would drop what was typed when the modal unmounts.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && popup.current?.contains(focused)) focused.blur();
    setClosing(true);
    window.setTimeout(onClose, 150);
  };

  useEffect(() => {
    const frame = requestAnimationFrame(() => { setShown(true); });
    popup.current?.focus({ preventScroll: true });
    return () => { cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A menu or dialog open inside the modal handles its own Escape.
      if (document.querySelector('[role="menu"], [role="listbox"], [data-slot="dialog-popup"]:not([data-app-modal])') !== null) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  });

  const visible = shown && !closing;
  return createPortal(
    <>
      <div aria-hidden className={`dialog-backdrop fixed inset-0 z-50 transition-opacity duration-150 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`} />
      <div
        className="app-no-drag fixed inset-0 z-50 flex items-center justify-center sm:p-6 sm:pt-[max(1.5rem,28px)] lg:p-10"
        onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget; }}
        onClick={(event) => { if (backdropPress.current && event.target === event.currentTarget) close(); backdropPress.current = false; }}
      >
        <div
          ref={popup}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          data-slot="dialog-popup"
          data-app-modal=""
          className={`relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground outline-none transition-[opacity,scale] duration-150 ease-out sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:border-border sm:shadow-2xl/40 ${visible ? 'scale-100 opacity-100' : 'scale-[0.985] opacity-0'}`}
        >
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** The ✕ at the right of a modal page's header. */
export function AppRouteModalClose({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Button size="icon" variant="ghost" aria-label="Close" title="Close (Esc)" onClick={onClose}>
      <XIcon size={16} />
    </Button>
  );
}
