// The app's icon set: lucide, (MIT, bundled — nothing
// loads from a CDN). Components keep these names so call sites never import
// lucide directly. Icons are decorative by default; pass aria-label + role="img"
// when one carries meaning.
import type { LucideIcon, LucideProps } from 'lucide-react';
import {
  ActivityIcon as LucideActivity,
  ArrowLeftIcon as LucideArrowLeft,
  ArrowRightIcon as LucideArrowRight,
  ArrowUpIcon as LucideArrowUp,
  BrainIcon as LucideBrain,
  BugIcon as LucideBug,
  CalendarIcon as LucideCalendar,
  ChartLineIcon as LucideChartLine,
  ChartNoAxesColumnIcon as LucideChartNoAxesColumn,
  CheckIcon as LucideCheck,
  ChevronDownIcon as LucideChevronDown,
  ChevronRightIcon as LucideChevronRight,
  CircleAlertIcon as LucideCircleAlert,
  ClockIcon as LucideClock,
  BotIcon as LucideBot,
  HistoryIcon as LucideHistory,
  CloudIcon as LucideCloud,
  CommandIcon as LucideCommand,
  CornerDownLeftIcon as LucideCornerDownLeft,
  DatabaseIcon as LucideDatabase,
  DownloadIcon as LucideDownload,
  EllipsisIcon as LucideEllipsis,
  ExternalLinkIcon as LucideExternalLink,
  EyeIcon as LucideEye,
  FileIcon as LucideFile,
  FileTextIcon as LucideFileText,
  FolderIcon as LucideFolder,
  FolderOpenIcon as LucideFolderOpen,
  FolderPlusIcon as LucideFolderPlus,
  GitBranchIcon as LucideGitBranch,
  GitPullRequestIcon as LucideGitPullRequest,
  GlobeIcon as LucideGlobe,
  GraduationCapIcon as LucideGraduationCap,
  HouseIcon as LucideHouse,
  ImageIcon as LucideImage,
  InboxIcon as LucideInbox,
  KeyRoundIcon as LucideKeyRound,
  LayersIcon as LucideLayers,
  ListChecksIcon as LucideListChecks,
  ListIcon as LucideList,
  MailIcon as LucideMail,
  MessageSquareIcon as LucideMessageSquare,
  MonitorIcon as LucideMonitor,
  NotebookTextIcon as LucideNotebookText,
  PanelLeftIcon as LucidePanelLeft,
  PanelRightIcon as LucidePanelRight,
  PaperclipIcon as LucidePaperclip,
  PencilIcon as LucidePencil,
  PlayIcon as LucidePlay,
  PlugIcon as LucidePlug,
  PlusIcon as LucidePlus,
  RefreshCwIcon as LucideRefreshCw,
  SearchIcon as LucideSearch,
  ServerIcon as LucideServer,
  SettingsIcon as LucideSettings,
  ShapesIcon as LucideShapes,
  ShieldCheckIcon as LucideShieldCheck,
  ShieldIcon as LucideShield,
  SmartphoneIcon as LucideSmartphone,
  SparklesIcon as LucideSparkles,
  SquarePenIcon as LucideSquarePen,
  TerminalIcon as LucideTerminal,
  TicketIcon as LucideTicket,
  Trash2Icon as LucideTrash2,
  TriangleAlertIcon as LucideTriangleAlert,
  UnlinkIcon as LucideUnlink,
  UsersIcon as LucideUsers,
  VideoIcon as LucideVideo,
  WorkflowIcon as LucideWorkflow,
  XIcon as LucideX,
  LoaderCircleIcon,
  SquareIcon,
} from 'lucide-react';

type IconProps = LucideProps & { size?: number };

const make = (Glyph: LucideIcon) => {
  const Wrapped = ({ size = 16, ...props }: IconProps): React.JSX.Element => (
    <Glyph size={size} aria-hidden={props['aria-label'] === undefined ? true : undefined} focusable="false" {...props} />
  );
  return Wrapped;
};

export const PlusIcon = make(LucidePlus);
export const VideoIcon = make(LucideVideo);
export const GlobeIcon = make(LucideGlobe);
export const PhoneIcon = make(LucideSmartphone);
export const BugIcon = make(LucideBug);
export const NoteIcon = make(LucideNotebookText);
export const ShapesIcon = make(LucideShapes);
export const ArrowLeftIcon = make(LucideArrowLeft);
export const ArrowRightIcon = make(LucideArrowRight);
export const ArrowUpIcon = make(LucideArrowUp);
export const ChevronRightIcon = make(LucideChevronRight);
export const ChevronDownIcon = make(LucideChevronDown);
export const XIcon = make(LucideX);
export const CheckIcon = make(LucideCheck);
export const FolderIcon = make(LucideFolder);
export const FolderOpenIcon = make(LucideFolderOpen);
export const SquarePenIcon = make(LucideSquarePen);
export const SettingsIcon = make(LucideSettings);
export const WorkflowIcon = make(LucideWorkflow);
export const SparklesIcon = make(LucideSparkles);
export const BrainIcon = make(LucideBrain);
export const PlugIcon = make(LucidePlug);
export const ActivityIcon = make(LucideActivity);
export const ListChecksIcon = make(LucideListChecks);
export const PanelRightIcon = make(LucidePanelRight);
export const PanelLeftIcon = make(LucidePanelLeft);
export const AlertTriangleIcon = make(LucideTriangleAlert);
export const AlertCircleIcon = make(LucideCircleAlert);
export const RotateIcon = make(LucideRefreshCw);
export const PlayIcon = make(LucidePlay);
export const FileTextIcon = make(LucideFileText);
export const DocumentIcon = make(LucideFile);
export const PaperclipIcon = make(LucidePaperclip);
export const ImageIcon = make(LucideImage);
export const TerminalIcon = make(LucideTerminal);
export const SearchIcon = make(LucideSearch);
export const ClockIcon = make(LucideClock);
export const BotIcon = make(LucideBot);
export const HistoryIcon = make(LucideHistory);
export const DatabaseIcon = make(LucideDatabase);
export const ShieldIcon = make(LucideShield);
export const ShieldCheckIcon = make(LucideShieldCheck);
export const EyeIcon = make(LucideEye);
export const PencilIcon = make(LucidePencil);
export const ListIcon = make(LucideList);
export const UsageIcon = make(LucideChartNoAxesColumn);
export const LayersIcon = make(LucideLayers);
export const MoreIcon = make(LucideEllipsis);
export const TrashIcon = make(LucideTrash2);
export const LinkOffIcon = make(LucideUnlink);
export const PullRequestIcon = make(LucideGitPullRequest);
export const ExternalLinkIcon = make(LucideExternalLink);
export const ChartIcon = make(LucideChartLine);
export const DownloadIcon = make(LucideDownload);
export const MonitorIcon = make(LucideMonitor);
export const GitBranchIcon = make(LucideGitBranch);
export const HomeIcon = make(LucideHouse);
export const GradCapIcon = make(LucideGraduationCap);
export const TicketIcon = make(LucideTicket);
export const MailIcon = make(LucideMail);
export const CalendarIcon = make(LucideCalendar);
export const MessageIcon = make(LucideMessageSquare);
export const ServerIcon = make(LucideServer);
export const KeyIcon = make(LucideKeyRound);
export const InboxIcon = make(LucideInbox);
export const CommandIcon = make(LucideCommand);
export const ReturnIcon = make(LucideCornerDownLeft);
export const FolderPlusIcon = make(LucideFolderPlus);
export const UsersIcon = make(LucideUsers);
export const CloudIcon = make(LucideCloud);

/** A filled square: the composer's stop button. */
export const StopIcon = ({ size = 16, ...props }: IconProps): React.JSX.Element => <SquareIcon size={size} fill="currentColor" strokeWidth={0} aria-hidden focusable="false" {...props} />;

/** Spinner: lucide's loader circle, spinning. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }): React.JSX.Element {
  return <LoaderCircleIcon size={size} className={`animate-spin ${className ?? ''}`} aria-hidden="true" focusable="false" />;
}
