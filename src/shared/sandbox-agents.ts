// Sandbox agents: named, single-purpose agents (a researcher, a QA tester, a
// data wrangler…) that run on the user's installed agent CLIs and do their
// work inside an isolated sandbox container (AIO Sandbox, agent-infra/sandbox):
// a real browser, a shell, files and code execution, reached over MCP.
// Risky sandbox actions go through Conductor's approval gate.

/** Tool families a sandbox offers; an agent is given a subset. */
export type SandboxToolGroup = 'browser' | 'shell' | 'files' | 'code' | 'documents';

export const SANDBOX_TOOL_GROUPS: ReadonlyArray<{ id: SandboxToolGroup; label: string; description: string }> = [
  { id: 'browser', label: 'Web browser', description: 'Open pages, click, type, scroll, take screenshots, read page content.' },
  { id: 'shell', label: 'Terminal', description: 'Run shell commands inside the sandbox.' },
  { id: 'files', label: 'Files', description: 'Read, write, search and edit files in the sandbox workspace.' },
  { id: 'code', label: 'Code runner', description: 'Run Python (Jupyter) and Node.js snippets.' },
  { id: 'documents', label: 'Documents', description: 'Convert PDFs, Office files and web pages to Markdown.' },
];

/**
 * Which sandbox actions stop for the user's approval.
 *  - risky: commands, code, file changes and browser actions that act on a
 *    page (click, type, submit); reading and looking never ask.
 *  - all: every tool call asks.
 *  - none: nothing asks; the sandbox is the boundary.
 * The permission profile still applies on top: trusted automation and the
 * auto-approve switch accept without asking, read-only declines risky calls.
 */
export type SandboxApprovalPolicy = 'risky' | 'all' | 'none';

/** Model and effort an agent runs a CLI with; an omitted field means Auto. */
export type AgentCliChoice = { model?: string; effort?: string };

export interface SandboxAgent {
  id: string;
  name: string;
  /** What this agent is for, shown on its card. */
  description: string;
  /** Standing instructions given to the CLI on every run. */
  instructions: string;
  /**
   * CLIs to run on, in order. The first available one runs the task; when it
   * is out of usage or cannot run the model, the next one takes over.
   */
  clis: string[];
  /** Model and effort chosen per CLI (by CLI id); a CLI not listed runs on Auto. */
  models: Record<string, AgentCliChoice>;
  tools: SandboxToolGroup[];
  approval: SandboxApprovalPolicy;
  /** Accent for the agent's icon. */
  color: string;
  /** The agent's icon as a small image data URL; empty when it has none (a coloured initial is shown). */
  icon: string;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxAgentInput {
  name: string;
  description: string;
  instructions: string;
  clis: string[];
  models?: Record<string, { model?: string | undefined; effort?: string | undefined }> | undefined;
  tools: SandboxToolGroup[];
  approval: SandboxApprovalPolicy;
  color: string;
  icon?: string | undefined;
}

/** What an agent icon may be: a small raster image, so it can live in the database and render anywhere. */
export const AGENT_ICON_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
export const MAX_AGENT_ICON_CHARS = 120_000;

/** A group chat with several agents. */
export interface AgentGroup {
  id: string;
  name: string;
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** One message the user sent to a group, and each member's reply task. */
export interface AgentGroupMessage {
  id: string;
  text: string;
  createdAt: string;
  /** Agent id → the task that answers it. */
  replies: Record<string, string>;
  /**
   * Agent id → the message held for a member who was still working when it
   * was sent: queued behind that work, or steering it (stopping it to answer).
   */
  waiting?: Record<string, { queueId: string; mode: 'steer' | 'queue' }>;
  /** How the members split this message; absent for messages sent before plans existed. */
  plan?: AgentGroupPlan;
}

/**
 * How a message to a group is carried out. `planning`: the planner is still
 * deciding. `parallel`: independent parts, one sandbox each, all at once.
 * `dag`: parts that build on each other, in one shared sandbox, each starting
 * when the parts it needs have finished.
 */
export interface AgentGroupPlan {
  mode: 'planning' | 'parallel' | 'dag';
  summary: string;
  steps: AgentGroupPlanStep[];
}

export interface AgentGroupPlanStep {
  agentId: string;
  instruction: string;
  /** Positions in `steps` of the parts this one waits for. */
  dependsOn: number[];
  status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
  /** Why it did not run or finish, when it did not. */
  note?: string;
}

/** Whether this machine can run sandboxes right now. */
export interface SandboxStatus {
  docker: 'ready' | 'not-installed' | 'not-running';
  /** Docker's own error text when it is not usable. */
  dockerDetail?: string;
  image: 'present' | 'missing' | 'pulling';
  /** 0–1 while the image downloads, when Docker reports layer progress. */
  pullProgress?: number;
  pullError?: string;
  /** The pinned image Conductor runs. */
  imageRef: string;
  /** Docker's memory and how much of it containers use now, in bytes. */
  memory?: { total: number; used: number };
  running: SandboxRun[];
}

/** One running sandbox container; each agent has at most one. */
export interface SandboxRun {
  agentId: string;
  agentName: string;
  startedAt: string;
  state: 'starting' | 'ready' | 'stopping';
}

/** The key the sandbox gateway is registered under in every CLI's MCP config. */
export const SANDBOX_MCP_KEY = 'sandbox';

/** Shown to a CLI when it reaches for its own shell, files or web tools in a sandbox agent's run. */
export const SANDBOX_ONLY_NOTICE = 'This agent works only inside its sandbox. Your own shell, file-editing and web tools are turned off here: '
  + `use the "${SANDBOX_MCP_KEY}" MCP tools (browser, terminal, files) instead, and do not retry the local tool.`;

export const SANDBOX_AGENT_COLORS = ['#c9379a', '#4a6fe8', '#2a9763', '#c58c1c', '#e0602c', '#7c5ce0', '#1f9bb0'] as const;

/**
 * Which browser agents and flows browse the web with:
 *  - device: Conductor's own Chrome on this Mac (separate profile, hidden or in the background).
 *  - cloud: the agent's or flow's cloud browser (WebDriver hub); the sandbox browser when none is set up.
 *  - sandbox: the sandbox's own browser.
 * With device or cloud, the sandbox starts only when the agent needs its terminal or files.
 */
export type BrowserPreference = 'device' | 'cloud' | 'sandbox';
export const BROWSER_PREFERENCE_KEY = 'sandbox.browserPreference';
export const isBrowserPreference = (value: unknown): value is BrowserPreference => value === 'device' || value === 'cloud' || value === 'sandbox';
/** The saved preference, reading the older "both" as cloud. */
export const browserPreferenceOf = (value: unknown, fallback: BrowserPreference = 'cloud'): BrowserPreference => (value === 'both' ? 'cloud' : isBrowserPreference(value) ? value : fallback);
/** Whether Conductor's Chrome shows its window (in the background) instead of running headless. */
export const DEVICE_CHROME_VISIBLE_KEY = 'sandbox.deviceChromeVisible';
/** Which of the user's own Chrome profiles agents start from: "auto" (the signed-in one with a picture) or its folder name. */
export const DEVICE_CHROME_PROFILE_KEY = 'sandbox.deviceChromeProfile';
