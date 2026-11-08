// Sandbox agents: named, single-purpose agents (a researcher, a QA tester, a
// data wrangler…) that run on the user's installed agent CLIs and do their
// work inside an isolated AIO Sandbox container (agent-infra/sandbox):
// a real browser, a shell, files and code execution, reached over MCP.
// Risky sandbox actions go through Conductor's approval gate.

/** Tool families the AIO Sandbox exposes; an agent is given a subset. */
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
  tools: SandboxToolGroup[];
  approval: SandboxApprovalPolicy;
  /** Accent for the agent's avatar. */
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxAgentInput {
  name: string;
  description: string;
  instructions: string;
  clis: string[];
  tools: SandboxToolGroup[];
  approval: SandboxApprovalPolicy;
  color: string;
}

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
