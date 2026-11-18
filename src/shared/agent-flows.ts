import { z } from 'zod';

// Flows: a canvas of agent steps joined by arrows. A step starts when every
// step pointing at it has finished, and is handed what they said. A flow runs
// by hand or on a schedule.

export const FLOW_MAX_NODES = 24;

export interface FlowNode {
  id: string;
  /** An agent step does work; a reply step pauses the flow until the user answers by email. */
  kind?: 'agent' | 'reply';
  /** The agent that does the step (empty for a reply step). */
  agentId: string;
  /** Run this step on this CLI instead of the agent's first available one. */
  cli?: string;
  /** Model and effort for that CLI; omitted means Auto. */
  model?: string;
  effort?: string;
  /** Reply steps: how long to wait for the answer before giving up. */
  waitHours?: number;
  /** What this step should do. `{{input}}` stands for the flow's input text. */
  prompt: string;
  x: number;
  y: number;
}
export interface FlowEdge { from: string; to: string }
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
export interface FlowRunNode { nodeId: string; status: FlowNodeStatus; taskId: string | null; output: string; note: string }
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
export const FlowInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  input: z.string().max(10_000).default(''),
  nodes: z.array(z.object({
    id, kind: z.enum(['agent', 'reply']).optional(), agentId: z.string().max(64), waitHours: z.number().int().min(1).max(24 * 14).optional(),
    cli: z.string().regex(/^[\w:.-]{1,200}$/).optional(), model: z.string().regex(/^[\w./:@-]{1,100}$/).optional(), effort: z.string().regex(/^[a-z]{2,12}$/).optional(),
    prompt: z.string().max(10_000), x: z.number().finite(), y: z.number().finite(),
  }).refine((node) => node.kind === 'reply' || z.string().uuid().safeParse(node.agentId).success, { message: 'A step needs an agent.' })).min(1).max(FLOW_MAX_NODES),
  edges: z.array(z.object({ from: id, to: id })).max(FLOW_MAX_NODES * FLOW_MAX_NODES),
  schedule: z.object({ cron: z.string().trim().min(1).max(100), enabled: z.boolean() }).nullable().default(null),
});
export type FlowInput = z.infer<typeof FlowInputSchema>;

/** Why a flow can't be saved or run, or undefined when it is sound. */
export function flowProblem(nodes: readonly Pick<FlowNode, 'id'>[], edges: readonly FlowEdge[]): string | undefined {
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) return 'Two steps share an id.';
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) return 'An arrow points at a step that does not exist.';
    if (edge.from === edge.to) return 'A step cannot wait for itself.';
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
