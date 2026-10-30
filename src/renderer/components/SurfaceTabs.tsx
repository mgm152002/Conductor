import { useLocation, useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chat-store';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { cn } from '../lib/cn';
import { ListChecksIcon, SquarePenIcon } from './ui/icons';

/**
 * Separate project work from personal, project-free conversations.
 * Switching surfaces always lands on a fresh composition — a new chat on
 * Chat, a new thread draft on Work — never the conversation that happened
 * to be open on that side before. Clicking the surface you are already on
 * leaves it untouched.
 */
export function SurfaceTabs(): React.JSX.Element {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { newThread } = useThreadNavigation();

  const switchTo = (to: '/work' | '/home'): void => {
    if (pathname === to) return;
    if (to === '/home') {
      useChatStore.getState().select(null);
      navigate('/home');
    } else {
      void newThread();
    }
  };

  return (
    <div aria-label="Workspace views" className="seg-control mx-3 mb-3 grid grid-cols-2">
      {[
        { to: '/work' as const, label: 'Work', Icon: ListChecksIcon, active: pathname !== '/home' },
        { to: '/home' as const, label: 'Chat', Icon: SquarePenIcon, active: pathname === '/home' },
      ].map(({ to, label, Icon, active }) => (
        <button
          key={to}
          type="button"
          onClick={() => { switchTo(to); }}
          aria-current={active ? 'page' : false}
          data-active={active}
          className={cn(
            'seg-item h-7 cursor-pointer justify-center text-xs focus-visible:outline-2 focus-visible:outline-ring',
          )}
        >
          <Icon size={14} />{label}
        </button>
      ))}
    </div>
  );
}
