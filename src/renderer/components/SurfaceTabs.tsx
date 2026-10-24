import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '../lib/cn';
import { ListChecksIcon, SquarePenIcon } from './ui/icons';

/** Separate project work from personal, project-free conversations. */
export function SurfaceTabs(): React.JSX.Element {
  const { pathname } = useLocation();
  return (
    <div aria-label="Workspace views" className="mx-3 mb-3 grid grid-cols-2 gap-1 rounded-lg bg-accent p-1">
      {[
        { to: '/work', label: 'Work', Icon: ListChecksIcon, active: pathname !== '/home' },
        { to: '/home', label: 'Chat', Icon: SquarePenIcon, active: pathname === '/home' },
      ].map(({ to, label, Icon, active }) => (
        <NavLink key={to} to={to} aria-current={active ? 'page' : false} className={cn(
          'flex h-8 items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
          active ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
        )}>
          <Icon size={14} />{label}
        </NavLink>
      ))}
    </div>
  );
}
