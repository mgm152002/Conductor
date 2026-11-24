import { z } from 'zod';

// Flows: a canvas of agent steps joined by arrows. A step starts when every
// step pointing at it has finished, and is handed what they said. A flow runs
// by hand or on a schedule.

export const FLOW_MAX_NODES = 24;
/** Review steps: feedback rounds after which the flow proceeds anyway. */
export const DEFAULT_MAX_ROUNDS = 3;
/** The two verdicts a review step's reply settles on. */
export type ReviewVerdict = 'approve' | 'revise';
export type FlowNodeKind = 'agent' | 'reply' | 'review';

export interface FlowNode {
  id: string;
  /** An agent step does work; a reply step pauses the flow until the user answers by email; a review step waits for a verdict and can send the work back. */
  kind?: FlowNodeKind;
  /** The agent that does the step (empty for a reply or review step). */
  agentId: string;
  /** Review steps: selecting a CLI enables agent-directed feedback routing. */
  /** Run this step on this CLI instead of the agent's first available one. */
  cli?: string;
  /** Model and effort for that CLI; omitted means Auto. */
  model?: string;
  effort?: string;
  /** Reply and review steps: how long to wait for the answer before giving up. */
  waitHours?: number;
  /** Review steps: send the feedback back to this step (a direct predecessor) for another pass. */
  loopTo?: string;
  /** Review steps: feedback rounds before the flow proceeds anyway (default 3). */
  maxRounds?: number;
  /** Review steps: what silence after waitHours means (default 'fail'). */
  onTimeout?: 'fail' | 'approve';
  /** What this step should do. `{{input}}` stands for the flow's input text. */
  prompt: string;
  x: number;
  y: number;
}

/** A run may contain generated bookkeeping nodes that are never editable or saved. */
/** A step as a run executes it. `attemptOf`: the saved step a rewind's fresh copy re-runs. */
export type FlowExecutionNode = Omit<FlowNode, 'kind'> & { kind?: FlowNodeKind | 'rewind'; attemptOf?: string };
/**
 * A branch condition on an arrow leaving a reply or review step: the reply
 * text is matched against `match` (case-insensitively) and the first arrow
 * whose condition fires stores its `label` as the step's branch, which is
 * what decides which arrows continue. `label` is free-form for reply steps
 * and exactly 'approve' | 'revise' for review steps; a review step's arrow
 * may omit `match` to fire on the built-in verdict instead.
 */
export interface FlowBranch { label: string; match?: string | undefined }
export interface FlowEdge { from: string; to: string; when?: FlowBranch | undefined }
/** A 5-field cron expression in the computer's local time. */
export interface FlowSchedule { cron: string; enabled: boolean }

export interface AgentFlow {
  id: string;
  name: string;
  /** Text every run starts from; steps see it as `{{input}}`. */
  input: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  schedule: FlowSchedule | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FlowNodeStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
export interface FlowRunNode {
  nodeId: string; status: FlowNodeStatus; taskId: string | null; output: string; note: string;
  /** The saved step this is (a rewind re-runs steps as fresh copies with new ids). */
  stepId: string;
  /** Which run of that step this is: 1, then 2, 3… after each rewind. */
  attempt: number;
  /** Review steps: how many feedback rounds have come back so far. */
  rounds?: number;
  /** The branch a reply or review step settled on; which arrows continue. */
  branch?: string;
}
export interface FlowRun {
  id: string;
  flowId: string;
  trigger: 'manual' | 'schedule';
  status: 'running' | 'done' | 'failed';
  /** The input this run started from. */
  input: string;
  startedAt: string;
  finishedAt: string | null;
  nodes: FlowRunNode[];
}

const id = z.string().trim().min(1).max(64);
const branch = z.object({ label: z.string().trim().min(1).max(40), match: z.string().min(1).max(200).optional() });
export const FlowInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  input: z.string().max(10_000).default(''),
  nodes: z.array(z.object({
    id, kind: z.enum(['agent', 'reply', 'review']).optional(), agentId: z.string().max(64), waitHours: z.number().int().min(1).max(24 * 14).optional(),
    cli: z.string().regex(/^[\w:.-]{1,200}$/).optional(), model: z.string().regex(/^[\w./:@-]{1,100}$/).optional(), effort: z.string().regex(/^[a-z]{2,12}$/).optional(),
    loopTo: id.optional(), maxRounds: z.number().int().min(1).max(10).optional(), onTimeout: z.enum(['fail', 'approve']).optional(),
    prompt: z.string().max(10_000), x: z.number().finite(), y: z.number().finite(),
  }).refine((node) => node.kind === 'reply' || node.kind === 'review' || z.string().uuid().safeParse(node.agentId).success, { message: 'A step needs an agent.' })
    .refine((node) => node.kind === 'review' || (node.loopTo === undefined && node.maxRounds === undefined && node.onTimeout === undefined), { message: 'Only a review step can send work back.' })).min(1).max(FLOW_MAX_NODES),
  edges: z.array(z.object({ from: id, to: id, when: branch.optional() })).max(FLOW_MAX_NODES * FLOW_MAX_NODES),
  schedule: z.object({ cron: z.string().trim().min(1).max(100), enabled: z.boolean() }).nullable().default(null),
});
export type FlowInput = z.infer<typeof FlowInputSchema>;

/** Why a flow can't be saved or run, or undefined when it is sound. */
export function flowProblem(
  nodes: readonly { id: string; kind?: FlowExecutionNode['kind'] | undefined; loopTo?: string | undefined }[],
  edges: readonly { from: string; to: string; when?: FlowBranch | undefined }[],
): string | undefined {
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) return 'Two steps share an id.';
  for (const node of nodes) {
    if (node.loopTo === undefined) continue;
    // The loop is a field, not a back-edge: the graph stays a DAG, and only a
    // review step may reset a direct predecessor of itself.
    if (node.kind !== 'review') return 'Only a review step can send work back to an earlier step.';
    if (node.loopTo === node.id || !ids.has(node.loopTo)) return 'A review step must send work back to a step that exists.';
    if (!edges.some((edge) => edge.from === node.loopTo && edge.to === node.id)) return 'A review step can only send work back to a step it waits on directly.';
  }
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) return 'An arrow points at a step that does not exist.';
    if (edge.from === edge.to) return 'A step cannot wait for itself.';
    if (edge.when !== undefined) {
      const source = nodes.find((node) => node.id === edge.from);
      if (source?.kind !== 'reply' && source?.kind !== 'review') return 'Only a reply or review step can branch on what came back.';
      if (edge.when.label.trim() === '') return 'A branch needs a name.';
      const match = edge.when.match?.trim();
      if (match !== undefined && match !== '') {
        try { new RegExp(match, 'i'); } catch { return 'A branch condition is not a valid pattern.'; }
      } else if (source.kind !== 'review') {
        return 'A reply step’s branch needs a pattern to match what came back.';
      }
      if (source.kind === 'review' && edge.when.label !== 'approve' && edge.when.label !== 'revise') return 'A review step’s arrows are labelled “approve” or “revise”.';
    }
  }
  const waiting = new Map(nodes.map((node) => [node.id, edges.filter((edge) => edge.to === node.id).length]));
  const queue = nodes.filter((node) => waiting.get(node.id) === 0).map((node) => node.id);
  let seen = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    seen += 1;
    for (const edge of edges) {
      if (edge.from !== current) continue;
      const left = (waiting.get(edge.to) ?? 0) - 1;
      waiting.set(edge.to, left);
      if (left === 0) queue.push(edge.to);
    }
  }
  return seen === nodes.length ? undefined : 'The arrows form a loop; a step cannot wait on itself through other steps.';
}

export const DEFAULT_REPLY_HOURS = 24;
