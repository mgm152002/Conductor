import { cn } from '../../lib/cn';
import { LayersIcon } from './icons';

// A Space/project's custom icon (data URL: generated SVG or uploaded image),
// falling back to the default mark — space glyph or the project's initials.

export function EntityIcon({ icon, name, kind, size = 20, active = false }: {
  icon?: string | null;
  name: string;
  kind: 'space' | 'project';
  size?: number;
  active?: boolean;
}): React.JSX.Element {
  if (icon) {
    return <img src={icon} alt="" aria-hidden="true" width={size} height={size} className="shrink-0 rounded-sm object-cover" style={{ width: size, height: size }} />;
  }
  if (kind === 'space') {
    return (
      <span aria-hidden="true" className="flex shrink-0 items-center justify-center text-sidebar-muted-foreground" style={{ width: size, height: size }}>
        <LayersIcon size={Math.max(12, size - 6)} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-sm text-3xs font-bold tracking-wide', active ? 'bg-primary text-primary-foreground' : 'bg-sidebar-row-active text-sidebar-muted-foreground')} style={{ width: size, height: size }}>
      {name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'P'}
    </span>
  );
}
