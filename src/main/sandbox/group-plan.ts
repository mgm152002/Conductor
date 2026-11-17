// Planning a message to a group. When the user asks the members of a group
// for work that builds on itself ("find the newest internship, then tailor my
// resume for it"), one agent's output is another's input. A planner reads the
// message and the members and decides:
//
//  - parallel: the members' parts are independent. Each runs at once, in its
//    own sandbox.
//  - dag: some parts need others' results. All of the members share ONE
//    sandbox, so files carry over, and each part starts once the parts it
//    depends on have finished, receiving their answers.
//
// This file is only the pure part: the prompt, reading the planner's reply,
// and the dependency rules. Running the plan is the service's job.

export interface PlanMember { id: string; name: string; description: string }
export interface GroupPlanStep {
  agentId: string;
  /** What this member is asked to do in this plan. */
  instruction: string;
  /** Positions in `steps` of the parts whose results this one needs. */
  dependsOn: number[];
}
export interface GroupPlan {
  mode: 'parallel' | 'dag';
  /** One line on how the work is split, for the user. */
  summary: string;
  steps: GroupPlanStep[];
}

const MAX_INSTRUCTION = 1500;
const MAX_SUMMARY = 240;

export function plannerPrompt(input: { text: string; members: readonly PlanMember[]; context?: string | undefined }): string {
  const members = input.members.map((member) => `- ${member.name}${member.description.trim() !== '' ? `: ${member.description.trim().slice(0, 200)}` : ''}`).join('\n');
  return [
    'You plan how the agents of a group chat split a request from the user.',
    'Each agent can use its own isolated sandbox (a browser, a terminal and files). Decide whether the agents\' parts are independent or build on each other.',
    '- If one agent needs another\'s result (for example "find the newest posting, then tailor my resume for it": the tailoring needs the posting), mark that with "after". Agents that depend on each other share one sandbox and run in order.',
    '- If no agent needs another\'s result, leave "after" empty for all of them. They then run at the same time, each in its own sandbox.',
    'Agents:',
    members,
    input.context !== undefined && input.context.trim() !== '' ? `What the agents said recently:\n${input.context.trim().slice(-2000)}` : '',
    `The user wrote:\n${input.text.slice(0, 4000)}`,
    'Reply with ONLY one JSON object in a ```json fenced block, shaped like:',
    '{"summary":"one short sentence on how the work is split","steps":[{"agent":"<agent name>","instruction":"what this agent must do, self-contained","after":["<agent name whose result this needs>"]}]}',
    'Rules: use each agent at most once, and only the agents listed; "after" names agents from the same list and never forms a loop; each instruction says exactly what that agent does (not what the others do) and, when it uses another agent\'s result, says so.',
  ].filter((part) => part !== '').join('\n\n');
}

/** Every member, in order, working on the user's message independently. */
export function defaultPlan(members: readonly PlanMember[], text: string): GroupPlan {
  return {
    mode: 'parallel',
    summary: members.length > 1 ? 'Everyone works on it at the same time.' : '',
    steps: members.map((member) => ({ agentId: member.id, instruction: text, dependsOn: [] })),
  };
}

function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const candidate = fenced?.[1] ?? reply;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(candidate.slice(start, end + 1)) as unknown; } catch { return undefined; }
}

/** Whether following `dependsOn` from any step ever returns to it. */
export function hasCycle(dependsOn: readonly (readonly number[])[]): boolean {
  const state = new Array<0 | 1 | 2>(dependsOn.length).fill(0);
  const visit = (node: number): boolean => {
    if (state[node] === 1) return true;
    if (state[node] === 2) return false;
    state[node] = 1;
    for (const next of dependsOn[node] ?? []) if (visit(next)) return true;
    state[node] = 2;
    return false;
  };
  return dependsOn.some((_deps, node) => visit(node));
}

/**
 * Read the planner's reply into a plan for exactly these members. Anything
 * that cannot be trusted (not JSON, an unknown agent, a loop) gives null, and
 * the caller falls back to the default plan. A member the planner left out
 * still runs, on the user's message, with no dependencies.
 */
export function parsePlan(reply: string, members: readonly PlanMember[], text: string): GroupPlan | null {
  const raw = extractJson(reply) as { summary?: unknown; steps?: unknown } | undefined;
  if (raw === undefined || raw === null || !Array.isArray(raw.steps)) return null;
  const find = (label: unknown): PlanMember | undefined => {
    if (typeof label !== 'string') return undefined;
    const wanted = label.trim().toLowerCase().replace(/^@/, '');
    return members.find((member) => member.name.toLowerCase() === wanted || member.id === label.trim());
  };
  const chosen: Array<{ member: PlanMember; instruction: string; after: PlanMember[] }> = [];
  for (const item of raw.steps as unknown[]) {
    const step = item as { agent?: unknown; instruction?: unknown; after?: unknown } | null;
    const member = find(step?.agent);
    if (member === undefined || chosen.some((entry) => entry.member.id === member.id)) continue;
    const instruction = typeof step?.instruction === 'string' && step.instruction.trim() !== '' ? step.instruction.trim().slice(0, MAX_INSTRUCTION) : text;
    const after = (Array.isArray(step?.after) ? step.after as unknown[] : []).map(find).filter((dep): dep is PlanMember => dep !== undefined && dep.id !== member.id);
    chosen.push({ member, instruction, after });
  }
  if (chosen.length === 0) return null;
  for (const member of members) if (!chosen.some((entry) => entry.member.id === member.id)) chosen.push({ member, instruction: text, after: [] });
  const position = new Map(chosen.map((entry, index) => [entry.member.id, index]));
  const dependsOn = chosen.map((entry) => [...new Set(entry.after.filter((dep) => position.has(dep.id)).map((dep) => position.get(dep.id)!))]);
  if (hasCycle(dependsOn)) return null;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, MAX_SUMMARY) : '';
  return {
    mode: dependsOn.some((deps) => deps.length > 0) ? 'dag' : 'parallel',
    summary,
    steps: chosen.map((entry, index) => ({ agentId: entry.member.id, instruction: entry.instruction, dependsOn: dependsOn[index]! })),
  };
}
