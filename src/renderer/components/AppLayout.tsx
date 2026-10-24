import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { AddProjectDialog } from './projects/AddProjectDialog';
import { Alert, Button } from './ui/primitives';
import { useSystemAppearance } from '../hooks/useSystemAppearance';
import { useTaskEvents } from '../hooks/useTaskEvents';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { useUiStore } from '../stores/ui-store';
import { useChatStore } from '../stores/chat-store';
import { useChatEvents } from '../hooks/useChatEvents';

// App shell in the T3 Code layout: a persistent project/thread sidebar beside
// the routed main surface. It owns the one app-wide data pump (task, approval
// and workspace events) and the system-appearance subscription, so both stay
// mounted across every screen (Requirement 22.1, 22.2).
export function AppLayout(): React.JSX.Element {
  useSystemAppearance();
  useChatEvents();
  const { errors, retry } = useTaskEvents();
  const { newThread } = useThreadNavigation();
  const { pathname } = useLocation();
  const notice = useUiStore((s) => s.notice);
  const setNotice = useUiStore((s) => s.setNotice);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (pathname === '/home') useChatStore.getState().select(null);
        else void newThread();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [newThread, pathname]);

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {errors.length > 0 || notice !== null ? (
          <div className="absolute top-14 right-4 left-4 z-30 mx-auto flex max-w-(--chat-max) flex-col gap-2">
            {notice !== null ? <Alert tone="warning" action={<Button size="xs" variant="ghost" onClick={() => { setNotice(null); }}>Dismiss</Button>}>{notice}</Alert> : null}
            {errors.length > 0 ? (
            <Alert action={<Button size="xs" variant="ghost" onClick={retry}>Retry loading</Button>}>
              <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
            </Alert>
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      <AddProjectDialog />
    </div>
  );
}
