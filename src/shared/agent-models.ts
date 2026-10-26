// Models and reasoning effort per agent CLI, and how a run picks them.

/** How demanding a request (or plan task) is; drives automatic model choice. */
export type Difficulty = 'simple' | 'moderate' | 'complex';

/** Relative cost class of a model within one agent's catalog. */
export type ModelTier = 'economy' | 'balanced' | 'premium';

export interface AgentModelOption {
  /** The value passed to the CLI (e.g. "gpt-5.6-luna", "sonnet"). */
  id: string;
  label: string;
  description?: string;
  tier: ModelTier;
  /** Effort levels this model accepts, when the CLI reports them. */
  efforts?: string[];
  isDefault?: boolean;
}

export interface AgentModelCatalog {
  agentId: string;
  models: AgentModelOption[];
  /** Effort levels the CLI accepts; empty when it has no effort setting. */
  efforts: string[];
  /** Where the list came from. */
  source: 'cli' | 'builtin' | 'none';
  error?: string;
}

/** A model and/or effort choice; an omitted field means Auto. */
export interface RunChoice {
  model?: string;
  effort?: string;
}

/** Per-message choices from the composer. */
export interface RunOptions {
  /** The chosen agent, or the planner in plan mode. */
  main?: RunChoice;
  /**
   * Agent the main choice belongs to. Set by the main process from the
   * selected agent, so a provider fallback never receives another CLI's
   * model slug.
   */
  mainAgentId?: string;
  /** Plan mode: choices for the agents that run the plan's tasks. */
  agents?: Record<string, RunChoice>;
}

/** What a step actually ran with, and why. */
export interface ResolvedRun {
  model?: string;
  effort?: string;
  /** "auto" when Conductor picked by difficulty. */
  source: 'composer' | 'settings' | 'auto' | 'default';
  difficulty?: Difficulty;
}

export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
