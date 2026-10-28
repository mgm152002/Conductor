import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '../lib/cn';
import { ListChecksIcon, SquarePenIcon } from './ui/icons';

/** Separate project work from personal, project-free conversations. */
export function SurfaceTabs(): React.JSX.Element {
  const { pathname } = useLocation();
  return (
    <div aria-label="Workspace views" className="seg-control mx-3 mb-3 grid grid-cols-2">
      {[
        { to: '/work', label: 'Work', Icon: ListChecksIcon, active: pathname !== '/home' },
        { to: '/home', label: 'Chat', Icon: SquarePenIcon, active: pathname === '/home' },
      ].map(({ to, label, Icon, active }) => (
        <NavLink key={to} to={to} aria-current={active ? 'page' : false} data-active={active} className={cn(
          'seg-item h-7 justify-center text-xs focus-visible:outline-2 focus-visible:outline-ring',
        )}>
          <Icon size={14} />{label}
        </NavLink>
      ))}
    </div>
  );
}
