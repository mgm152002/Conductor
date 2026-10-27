import type { SVGProps } from 'react';

// A small inline stroke-icon set (24px grid, 1.75 stroke) so the renderer needs
// no icon dependency and nothing loads from a CDN (CSP is self-only). Icons are
// decorative by default; pass aria-label + role="img" when one carries meaning.

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props['aria-label'] === undefined ? true : undefined}
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const ArrowUpIcon = (p: IconProps) => <Icon {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Icon>;
export const StopIcon = (p: IconProps) => <Icon {...p}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></Icon>;
export const ChevronRightIcon = (p: IconProps) => <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>;
export const ChevronDownIcon = (p: IconProps) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
export const XIcon = (p: IconProps) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>;
export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="m5 12 5 5 9-10" /></Icon>;
export const FolderIcon = (p: IconProps) => <Icon {...p}><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /></Icon>;
export const FolderOpenIcon = (p: IconProps) => <Icon {...p}><path d="M3 17V7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5V11" /><path d="M3 17.5 5.2 12a1.5 1.5 0 0 1 1.4-1h13.2a1 1 0 0 1 .9 1.4L18.6 18a1.5 1.5 0 0 1-1.4 1H4.5A1.5 1.5 0 0 1 3 17.5z" /></Icon>;
export const SquarePenIcon = (p: IconProps) => <Icon {...p}><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8l-3.6.8.8-3.6z" /></Icon>;
export const SettingsIcon = (p: IconProps) => <Icon {...p}><path d="M10.3 3.6a1.7 1.7 0 0 1 3.4 0l.1.7a1.7 1.7 0 0 0 2.5 1.1l.6-.4a1.7 1.7 0 0 1 2.4 2.4l-.4.6a1.7 1.7 0 0 0 1.1 2.5l.7.1a1.7 1.7 0 0 1 0 3.4l-.7.1a1.7 1.7 0 0 0-1.1 2.5l.4.6a1.7 1.7 0 0 1-2.4 2.4l-.6-.4a1.7 1.7 0 0 0-2.5 1.1l-.1.7a1.7 1.7 0 0 1-3.4 0l-.1-.7a1.7 1.7 0 0 0-2.5-1.1l-.6.4a1.7 1.7 0 0 1-2.4-2.4l.4-.6a1.7 1.7 0 0 0-1.1-2.5l-.7-.1a1.7 1.7 0 0 1 0-3.4l.7-.1A1.7 1.7 0 0 0 5.6 7.5l-.4-.6a1.7 1.7 0 0 1 2.4-2.4l.6.4a1.7 1.7 0 0 0 2.5-1.1z" /><circle cx="12" cy="12" r="3" /></Icon>;
export const WorkflowIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><path d="M6.5 10v4a3 3 0 0 0 3 3H14" /></Icon>;
export const SparklesIcon = (p: IconProps) => <Icon {...p}><path d="M12 3.5 13.8 9a1.5 1.5 0 0 0 1 1l5.5 1.8-5.5 1.8a1.5 1.5 0 0 0-1 1L12 20.1l-1.8-5.5a1.5 1.5 0 0 0-1-1L3.7 11.8 9.2 10a1.5 1.5 0 0 0 1-1z" /><path d="M19 3v4M21 5h-4" /></Icon>;
export const BrainIcon = (p: IconProps) => <Icon {...p}><path d="M9.5 4A2.5 2.5 0 0 0 7 6.5v.1A3 3 0 0 0 5 12a3 3 0 0 0 2 5.4A2.6 2.6 0 0 0 12 18V5.5A1.5 1.5 0 0 0 10.5 4z" /><path d="M14.5 4A2.5 2.5 0 0 1 17 6.5v.1a3 3 0 0 1 2 5.4 3 3 0 0 1-2 5.4A2.6 2.6 0 0 1 12 18" /></Icon>;
export const PlugIcon = (p: IconProps) => <Icon {...p}><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" /></Icon>;
export const ActivityIcon = (p: IconProps) => <Icon {...p}><path d="M3 12h4l3-8 4 16 3-8h4" /></Icon>;
export const ListChecksIcon = (p: IconProps) => <Icon {...p}><path d="m3 7 2 2 3-3M3 16l2 2 3-3M12 7h9M12 17h9" /></Icon>;
export const PanelRightIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Icon>;
export const AlertTriangleIcon = (p: IconProps) => <Icon {...p}><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></Icon>;
export const AlertCircleIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></Icon>;
export const RotateIcon = (p: IconProps) => <Icon {...p}><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /></Icon>;
export const PlayIcon = (p: IconProps) => <Icon {...p}><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z" /></Icon>;
export const FileTextIcon = (p: IconProps) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></Icon>;
export const DocumentIcon = FileTextIcon;
export const PaperclipIcon = (p: IconProps) => <Icon {...p}><path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5" /></Icon>;
export const ImageIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><path d="m21 15-5-5L5 21" /></Icon>;
export const TerminalIcon = (p: IconProps) => <Icon {...p}><path d="m5 8 4 4-4 4M12 17h7" /></Icon>;
export const SearchIcon = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
export const ClockIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const DatabaseIcon = (p: IconProps) => <Icon {...p}><ellipse cx="12" cy="5.5" rx="8" ry="2.5" /><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></Icon>;
export const ShieldIcon = (p: IconProps) => <Icon {...p}><path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z" /></Icon>;
export const ShieldCheckIcon = (p: IconProps) => <Icon {...p}><path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z" /><path d="m9 12 2 2 4-4" /></Icon>;
export const EyeIcon = (p: IconProps) => <Icon {...p}><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" /><circle cx="12" cy="12" r="2.5" /></Icon>;
export const PencilIcon = (p: IconProps) => <Icon {...p}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></Icon>;
export const ListIcon = (p: IconProps) => <Icon {...p}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></Icon>;
export const UsageIcon = (p: IconProps) => <Icon {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Icon>;
export const LayersIcon = (p: IconProps) => <Icon {...p}><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></Icon>;
export const MoreIcon = (p: IconProps) => <Icon {...p}><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></Icon>;
export const TrashIcon = (p: IconProps) => <Icon {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></Icon>;
export const LinkOffIcon = (p: IconProps) => <Icon {...p}><path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 4 8M3 3l18 18" /></Icon>;

export function Spinner({ size = 14, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`animate-spin ${className ?? ''}`} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
export const MailIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6 8.5-6" /></Icon>;
export const CalendarIcon = (p: IconProps) => <Icon {...p}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M8 3v4M16 3v4M3.5 10h17" /></Icon>;
export const MessageIcon = (p: IconProps) => <Icon {...p}><path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" /></Icon>;
export const ServerIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></Icon>;
export const KeyIcon = (p: IconProps) => <Icon {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" /></Icon>;
