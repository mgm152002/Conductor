import type { WorkEntry } from '../../lib/timeline';
import {
  ActivityIcon,
  FileTextIcon,
  ListChecksIcon,
  PlayIcon,
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
} from '../ui/icons';

const ICONS: Record<WorkEntry['icon'], (p: { size?: number; className?: string }) => React.JSX.Element> = {
  terminal: TerminalIcon,
  file: FileTextIcon,
  thinking: SparklesIcon,
  tool: PlayIcon,
  search: SearchIcon,
  read: FileTextIcon,
  plan: ListChecksIcon,
  state: ActivityIcon,
  artifact: FileTextIcon,
  approval: ShieldIcon,
};

/** The icon for one streamed work entry, shared by timelines and the live feed. */
export function WorkIcon({ icon, size = 13, className }: { icon: WorkEntry['icon']; size?: number; className?: string }): React.JSX.Element {
  const Icon = ICONS[icon];
  return <Icon size={size} {...(className !== undefined ? { className } : {})} />;
}
