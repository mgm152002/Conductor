import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { AddProjectDialog } from './projects/AddProjectDialog';
import { OnboardingWalkthrough } from './onboarding/OnboardingWalkthrough';
import { Alert, Button } from './ui/primitives';
import { useSystemAppearance } from '../hooks/useSystemAppearance';
import { useTaskEvents } from '../hooks/useTaskEvents';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { useUiStore } from '../stores/ui-store';
import { useChatStore } from '../stores/chat-store';
import { useChatEvents } from '../hooks/useChatEvents';
import { useThreadLoaders } from '../hooks/useThreadLoaders';

// App shell: the top bar on every screen and the routed surface filling the
// window below it. On the two surfaces that have threads (Work and Chat) an
// optional thread drawer can sit at the left.
// ⌘K opens the command palette, ⌘B shows or hides the thread drawer,
// ⌘N starts a new thread or chat, ⌘, opens Settings. It owns the one app-wide data pump (task, approval
// and workspace events) and the system-appearance subscription, so both stay
// mounted across every screen (Requirement 22.1, 22.2).
export function AppLayout(): React.JSX.Element {
  useSystemAppearance();
  useChatEvents();
  useThreadLoaders();
  const { errors, retry } = useTaskEvents();
  const { newThread } = useThreadNavigation();
  const { pathname } = useLocation();
  const notice = useUiStore((s) => s.notice);
  const setNotice = useUiStore((s) => s.setNotice);

  const navigate = useNavigate();
  const panelCollapsed = useUiStore((s) => s.panelCollapsed);
  const hasThreads = pathname === '/home' || pathname === '/work' || pathname.startsWith('/pr/');

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        if (pathname === '/home') useChatStore.getState().select(null);
        else void newThread();
      } else if (key === 'k') {
        event.preventDefault();
        const ui = useUiStore.getState();
        ui.setPaletteOpen(!ui.paletteOpen);
      } else if (key === 'b') {
        event.preventDefault();
        const ui = useUiStore.getState();
        ui.setPanelCollapsed(!ui.panelCollapsed);
      } else if (key === ',') {
        event.preventDefault();
        navigate('/settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [newThread, pathname, navigate]);

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {hasThreads && !panelCollapsed ? <Sidebar /> : null}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {errors.length > 0 || notice !== null ? (
            <div className="absolute top-3 right-4 left-4 z-30 mx-auto flex max-w-(--chat-max) flex-col gap-2">
              {notice !== null ? <Alert tone="warning" action={<Button size="xs" variant="ghost" onClick={() => { setNotice(null); }}>Dismiss</Button>}>{notice}</Alert> : null}
              {errors.length > 0 ? (
              <Alert action={<Button size="xs" variant="ghost" onClick={retry}>Retry loading</Button>}>
                <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
              </Alert>
              ) : null}
            </div>
          ) : null}
          {/* One page-in per top-level navigation; deeper route changes (a
              different PR, another thread) keep the same key and don't replay. */}
          <div key={pathname.split('/')[1] ?? ''} className="animate-page-in min-h-0 flex-1">
            <Outlet />
          </div>
        </main>
      </div>
      <AddProjectDialog />
      <CommandPalette />
      <OnboardingWalkthrough />
    </div>
  );
}
