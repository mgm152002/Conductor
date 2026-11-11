import { useLocation, useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chat-store';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { MessageIcon, TerminalIcon } from './ui/icons';

/**
 * The two working surfaces, as the primary tabs of the top bar: Work
 * (project threads) and Chat (personal, project-free conversations).
 * Choosing a surface always lands on its board — the Work board with a fresh
 * thread draft, the Chat start page with a new chat — never the conversation
 * that happened to be open on that side before. That also makes the tab the
 * way back to the board from an open thread.
 */
export function SurfaceTabs({ attention = 0 }: { /** Approvals and questions waiting on the user in Work. */ attention?: number } = {}): React.JSX.Element {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { newThread } = useThreadNavigation();
  const onWork = pathname === '/work' || pathname.startsWith('/pr/');

  const switchTo = (to: '/work' | '/home'): void => {
    if (to === '/home') {
      useChatStore.getState().select(null);
      navigate('/home');
    } else {
      void newThread();
    }
  };

  return (
    <div aria-label="Workspace views" className="flex shrink-0 items-center gap-0.5">
      {[
        { to: '/work' as const, label: 'Work', title: 'Work board — project threads', Icon: TerminalIcon, active: onWork, badge: attention },
        { to: '/home' as const, label: 'Chat', title: 'Chat — personal conversations', Icon: MessageIcon, active: pathname === '/home', badge: 0 },
      ].map(({ to, label, title, Icon, active, badge }) => (
        <button
          key={to}
          type="button"
          onClick={() => { switchTo(to); }}
          aria-current={active ? 'page' : false}
          data-active={active}
          data-primary="true"
          title={badge > 0 ? `${title} — ${badge} waiting on you` : title}
          className="bar-tab"
        >
          <Icon size={14} />
          {badge > 0 ? <span className="order-last flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold text-black tabular-nums">{badge}</span> : null}{label}</button>
      ))}
    </div>
  );
}
