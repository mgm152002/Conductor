import { FLOW_MAX_NODES, flowProblem, type FlowEdge, type FlowInput, type FlowNode } from '@shared/agent-flows';
import { nextCronRun } from './cron';

// Building a flow from a sentence. A model reads what the user wants and the
// agents they have, and answers with steps; this file writes the prompt and
// turns the answer into a flow that is safe to put on the canvas.

export interface DraftAgent { id: string; name: string; description: string }

export function draftPrompt(description: string, agents: readonly DraftAgent[], mail: boolean): string {
  const list = agents.map((agent) => `- ${agent.name}${agent.description.trim() !== '' ? `: ${agent.description.trim().slice(0, 200)}` : ''}`).join('\n');
  return [
    'You design a workflow for a user from their description. A workflow is steps joined by "after" links; a step starts when every step it comes after has finished and is handed what they said. Steps with nothing between them run at the same time.',
    'Step kinds:',
    '- "agent": one of the user\'s agents does a job (it can browse the web in its own sandbox, run code, work with files, and use any tools the user connected, such as Google Drive).',
    mail ? '- "reply": pauses the workflow until the user answers an email. Put it after the step that emails the user. What the user wrote back is handed to the steps after it. The emailing step must use the email_send tool; say so in its prompt.' : '- "reply" is not available (email is not connected); do not use it.',
    'The user\'s agents:',
    list,
    `The user wrote:\n${description.slice(0, 4000)}`,
    'Reply with ONLY one JSON object in a ```json fenced block:',
    '{"name":"short title","input":"the text a run starts from: what the user wants this run to find or do, filled in from their description, with the details they care about on separate lines","steps":[{"key":"s1","kind":"agent","agent":"<agent name>","prompt":"exactly what this step does, self-contained; write {{input}} where the run\'s input belongs","after":[]},{"key":"s2","kind":"reply","waitHours":24,"after":["s1"]}],"schedule":null}',
    'For a schedule use {"cron":"minute hour day month weekday"} in the user\'s local time (for example "0 9,17 * * *" is 9:00 and 17:00 every day), otherwise null.',
    `Rules: use only the agents listed (the same agent may have several steps); never more than ${FLOW_MAX_NODES} steps; "after" lists keys of earlier steps and never loops; each prompt names the output the next step needs; steps that need the user's own data (a resume, accounts) say where to find it or to ask.`,
  ].join('\n\n');
}

function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const candidate = fenced?.[1] ?? reply;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(candidate.slice(start, end + 1)) as unknown; } catch { return undefined; }
}

export const NODE_W = 232;
const GAP_X = 70;
const ROW_H = 130;

/** Left to right by how many steps come before, top to bottom within a column. */
export function layout(nodes: readonly Pick<FlowNode, 'id'>[], edges: readonly FlowEdge[]): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const level = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const value = Math.max(-1, ...edges.filter((edge) => edge.to === id).map((edge) => level(edge.from, seen))) + 1;
    depth.set(id, value);
    return value;
  };
  const rows = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const column = level(node.id, new Set());
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    out.set(node.id, { x: 60 + column * (NODE_W + GAP_X), y: 60 + row * ROW_H });
  }
  return out;
}

/** The flow a model's reply describes, or the reason it can't be used. */
export function parseDraft(reply: string, agents: readonly DraftAgent[], mail: boolean): { flow: Omit<FlowInput, 'id'> } | { error: string } {
  const raw = extractJson(reply) as { name?: unknown; input?: unknown; steps?: unknown; schedule?: unknown } | undefined;
  if (raw === undefined || raw === null || !Array.isArray(raw.steps) || raw.steps.length === 0) return { error: 'The model did not describe any steps. Try saying more about what each part should do.' };
  const find = (label: unknown): DraftAgent | undefined => {
    if (typeof label !== 'string') return undefined;
    const wanted = label.trim().toLowerCase().replace(/^@/, '');
    return agents.find((agent) => agent.name.toLowerCase() === wanted || agent.id === label.trim());
  };
  const keys = new Map<string, string>();
  const nodes: FlowInput['nodes'] = [];
  const links: Array<{ id: string; after: unknown }> = [];
  for (const [index, item] of (raw.steps as unknown[]).slice(0, FLOW_MAX_NODES).entries()) {
    const step = item as { key?: unknown; kind?: unknown; agent?: unknown; prompt?: unknown; after?: unknown; waitHours?: unknown } | null;
    const id = `step-${index + 1}`;
    const key = typeof step?.key === 'string' ? step.key : id;
    const prompt = typeof step?.prompt === 'string' ? step.prompt.trim().slice(0, 10_000) : '';
    if (step?.kind === 'reply') {
      if (!mail) return { error: 'This needs the user to reply by email, but email is not connected yet. Connect AgentMail first.' };
      const hours = typeof step.waitHours === 'number' && Number.isFinite(step.waitHours) ? Math.min(Math.max(Math.round(step.waitHours), 1), 24 * 14) : 24;
      nodes.push({ id, kind: 'reply', agentId: '', waitHours: hours, prompt: '', x: 0, y: 0 });
    } else {
      const agent = find(step?.agent);
      if (agent === undefined) return { error: `The model chose an agent that does not exist ("${typeof step?.agent === 'string' ? step.agent : '?'}"). Create it first or name your agents in the description.` };
      nodes.push({ id, kind: 'agent', agentId: agent.id, prompt, x: 0, y: 0 });
    }
    keys.set(key, id);
    links.push({ id, after: step?.after });
  }
  const edges: FlowEdge[] = [];
  for (const link of links) {
    for (const key of Array.isArray(link.after) ? link.after as unknown[] : []) {
      const from = typeof key === 'string' ? keys.get(key) : undefined;
      if (from !== undefined && from !== link.id && !edges.some((edge) => edge.from === from && edge.to === link.id)) edges.push({ from, to: link.id });
    }
  }
  const problem = flowProblem(nodes, edges);
  if (problem !== undefined) return { error: problem };
  const places = layout(nodes, edges);
  const placed = nodes.map((node) => ({ ...node, ...(places.get(node.id) ?? { x: 60, y: 60 }) }));
  const cron = (raw.schedule as { cron?: unknown } | null)?.cron;
  const schedule = typeof cron === 'string' && nextCronRun(cron, new Date()) !== undefined ? { cron: cron.trim(), enabled: false } : null;
  return {
    flow: {
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 80) : 'New flow',
      input: typeof raw.input === 'string' ? raw.input.slice(0, 10_000) : '',
      nodes: placed, edges, schedule,
    },
  };
}
