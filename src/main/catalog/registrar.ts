// The CliRegistrar keeps the Registry in sync with a catalog entry's
// `installed` status. It translates "an installed entry" into a registered
// `LocalCliAdapter` and back, using the entry's stable id as the adapter id so
// the two never drift: "is this entry's adapter registered?" is exactly
// `registry.has(entry.id)` (Requirement 3.2 dedupe) and disappearance is
// `registry.deregister(entry.id)` (Requirement 3.3).
//
// It never searches PATH itself — discovery and status derivation live
// elsewhere. It only reflects a decision already made ("this entry is
// installed, here is the discovered binary name") into the Registry.

import {
  LocalCliAdapter,
  defaultCliEnvironment,
  type CliEnvironment,
} from '../adapters/local-cli-adapter';
import { ObjectiveCliAdapter } from '../adapters/objective-cli-adapter';
import { RUNNABLE_AGENT_IDS } from '../adapters/objective-cli-adapter';
import { CodexAppServerAdapter } from '../adapters/codex-app-server-adapter';
import type { ToolApprover } from '../adapters/tool-gate';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter';
import { AntigravityAdapter } from '../adapters/antigravity-adapter';
import { ACP_AGENTS, AcpAgentAdapter } from '../adapters/acp-agent-adapter';
import type { AgentAdapter } from '@shared/adapter';
import { Registry } from '../registry/registry';
import type { CapabilityDescriptor } from '@shared/adapter';
import { capabilityIdFor, type CatalogEntry } from '@shared/catalog';

/**
 * The outcome of an `ensureRegistered` call. Distinguishes a fresh
 * registration from a deduped no-op and from a failure, so the catalog can keep
 * the entry `installed` and surface a registration failure to the user
 * (Requirement 3.4) rather than silently dropping it to `available`.
 */
export type RegistrationResult =
  | { kind: 'registered' }
  | { kind: 'already_present' }
  | { kind: 'failed'; error: string };

/**
 * Build the single capability descriptor an entry's adapter advertises. It
 * reuses the exact shape `createClaudeCodeAdapter` produces (streaming,
 * cancellable, non-resumable; command_exec + filesystem read/write
 * permissions; args/stdin input schema, object output schema), differing only
 * in the capability id — derived from the entry via `capabilityIdFor` — and the
 * title, which names the entry.
 */
function capabilityForEntry(entry: CatalogEntry): CapabilityDescriptor {
  return {
    id: capabilityIdFor(entry),
    title: `Run a ${entry.displayName} agent session`,
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' } },
        stdin: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    streaming: true,
    cancellable: true,
    resumable: false,
    requiredPermissions: [
      { kind: 'command_exec' },
      { kind: 'filesystem_read' },
      { kind: 'filesystem_write' },
    ],
    costHint: 'medium',
    latencyHint: 'medium',
  };
}

export class CliRegistrar {
  private readonly registry: Registry;
  private readonly env: CliEnvironment;

  constructor(registry: Registry, env: CliEnvironment = defaultCliEnvironment(), private readonly beforeStart?: (id:string)=>void,
    /**
     * When set, agents ask per tool call through this: Codex over app-server,
     * Claude Code through its permission prompt tool, OpenCode and Kiro over
     * ACP, and Antigravity through a PreToolUse hook.
     */
    private readonly toolApprover?: ToolApprover,
    /** The user's "auto-approve everything" toggle, read per tool call. */
    private readonly autoApprove?: () => boolean) {
    this.registry = registry;
    this.env = env;
  }

  /**
   * Register a `LocalCliAdapter` for an installed entry if one is not already
   * registered under the entry's id. The adapter's `command` is set to the
   * discovered binary name (not an absolute path — `LocalCliAdapter`
   * re-discovers on PATH), and it advertises the single capability derived from
   * the entry.
   *
   * Dedupe (Requirement 3.2): when `registry.has(entry.id)` is already true this
   * is a no-op returning `already_present`, so repeated calls never register a
   * duplicate or raise a duplicate error. When `registry.register` throws
   * (contract/duplicate error), this returns `{ kind: 'failed', error }` so the
   * caller can keep the entry `installed` and surface the failure
   * (Requirement 3.4).
   */
  ensureRegistered(entry: CatalogEntry, resolvedBinary: string): RegistrationResult {
    if (this.registry.has(entry.id)) {
      return { kind: 'already_present' };
    }

    const capability = capabilityForEntry(entry);
    const objectiveCap = {...capability, id: 'objective.fulfill', title: `Complete a task with ${entry.displayName}`};
    // Follow-ups in a thread pin the agent that ran the previous turn so the
    // conversation (and, for Codex, the provider session) continues.
    const pinnedCap = {...objectiveCap, id: `objective.fulfill.${entry.id}`, title: `Continue a conversation with ${entry.displayName}`};
    const gated = this.toolApprover !== undefined ? this.gatedAdapter(entry, resolvedBinary, this.toolApprover,
      [capability, {...objectiveCap, toolApprovals: true}, {...pinnedCap, toolApprovals: true}]) : undefined;
    const adapter = gated !== undefined
      ? gated
      : RUNNABLE_AGENT_IDS.has(entry.id)
      ? new ObjectiveCliAdapter(entry.id, entry, resolvedBinary, [capability, objectiveCap, pinnedCap], this.env, this.beforeStart)
      : new LocalCliAdapter(
      {
        id: entry.id,
        name: entry.displayName,
        version: '1.0.0',
        command: resolvedBinary,
        capabilities: [capabilityForEntry(entry)],
      },
      this.env,
    );

    try {
      this.registry.register(adapter);
    } catch (err) {
      return {
        kind: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return { kind: 'registered' };
  }

  /** The adapter that asks per tool call for this agent, if it has one. */
  private gatedAdapter(entry: CatalogEntry, command: string, approver: ToolApprover, capabilities: CapabilityDescriptor[]): AgentAdapter | undefined {
    const config = { id: entry.id, name: entry.displayName, command, capabilities, ...(this.autoApprove !== undefined ? { autoApprove: this.autoApprove } : {}) };
    switch (entry.id) {
      case 'codex': return new CodexAppServerAdapter(config, approver, this.env, this.beforeStart);
      case 'claude-code': return new ClaudeCodeAdapter(config, approver, this.env, this.beforeStart);
      case 'antigravity': return new AntigravityAdapter(config, approver, this.env, this.beforeStart);
      case 'opencode':
      case 'kiro': return new AcpAgentAdapter(config, ACP_AGENTS[entry.id]!, approver, this.env, this.beforeStart);
      default: return undefined;
    }
  }

  /**
   * Deregister the entry's adapter when it is no longer on PATH
   * (Requirement 3.3). Delegates to `registry.deregister`, which is a no-op when
   * no adapter is registered under that id.
   */
  ensureDeregistered(entryId: string): void {
    this.registry.deregister(entryId);
  }
}
