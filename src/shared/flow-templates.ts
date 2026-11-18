import type { FlowEdge, FlowNode, FlowSchedule } from './agent-flows';

// Ready-made flows. A template names its steps by role; the editor fills in
// whichever of the user's agents fits each role best.

export type TemplateRole = 'scraper' | 'tailor' | 'applier';
export interface FlowTemplate {
  id: string;
  title: string;
  summary: string;
  roles: Array<{ role: TemplateRole; label: string; hint: RegExp }>;
  build(agents: Record<TemplateRole, string>): { name: string; input: string; nodes: FlowNode[]; edges: FlowEdge[]; schedule: FlowSchedule | null };
}

const SIMPLIFY = 'https://github.com/SimplifyJobs/Summer2027-Internships';

export const INTERNSHIP_INPUT = `Roles: software engineering internships (backend or full-stack)
Locations: United States, or remote
Must have: still open and accepting applications
Skip: anything that needs US citizenship or a security clearance
How many: the 10 newest matching postings`;

export const INTERNSHIP_TEMPLATE: FlowTemplate = {
  id: 'summer-2027-internships',
  title: 'Summer 2027 internships',
  summary: 'Find matching internships, tailor a resume for each into its own Drive folder, email you the list, and apply when you reply.',
  roles: [
    { role: 'scraper', label: 'Finds the jobs', hint: /scrap|search|find|research|browse/i },
    { role: 'tailor', label: 'Tailors resumes', hint: /resume|cv|tailor|writer/i },
    { role: 'applier', label: 'Applies', hint: /appl|submit|form/i },
  ],
  build(agents) {
    const nodes: FlowNode[] = [
      { id: 'find', kind: 'agent', agentId: agents.scraper, x: 60, y: 60, prompt: `Find internship postings that match what I asked for. Look in ${SIMPLIFY} (the README tables, and its other listed sources if needed) and open each posting to confirm it is still open.\n\nWhat I want:\n{{input}}\n\nInclude ONLY postings that match all of it; if fewer match, return fewer. Do not pad the list. Reply with a numbered list, one posting per item: company, role, location, the direct apply link, and a two-line summary of the requirements and the skills they ask for.` },
      { id: 'tailor', kind: 'agent', agentId: agents.tailor, x: 362, y: 60, prompt: `For each posting in the list you were given, tailor my resume.\nBuild every resume fresh in this run by re-running your pipeline for each posting: never reuse a PDF, run folder or Drive file from an earlier run, even for the same company and role (the layout may have been fixed since). If a Drive file with the same name is already in the folder, replace it with the new PDF (upload it as a new version) so the link stays the same.\n0. Follow your standing instructions and use your own resume tools and pipeline exactly as they say; this workflow's steps share one workspace (look in the workspace and shared folders, and install anything missing, such as TeX).\n1. Find my base resume and pipeline (search your memory, the workspace and the shared folder).\n2. Rewrite it for that posting: reorder and reword real experience to match what they ask for; never invent experience.\n3. With the Google Drive tool, create a folder named "Applications / <today's date> / <Company> - <Role>" and upload the tailored resume (PDF) into it. Your Drive tool runs on my Mac and cannot see the sandbox, so first copy each PDF out with save_to_mac and upload from the Mac path it returns (the upload tool's local path); never paste base64. Get a link anyone with it can open.\nIf you cannot make a resume for a posting, do not invent one: say "RESUME FAILED" and why, first thing in your reply.\nReply with the numbered list again, each item keeping its company, role and apply link, plus "Resume: <Drive link>".` },
      { id: 'email', kind: 'agent', agentId: agents.tailor, x: 664, y: 60, prompt: `Email me the list with email_send. If any posting has no resume link, say so in the first line of the body and start the subject with "ACTION NEEDED:". Subject: "Internships found: <count> to review". In the body, one item per line block: number, company, role, location, apply link, resume link. End with: "Reply "apply to all" to apply to every one, or list the numbers to apply to (for example "1, 3, 4"), or "none".".` },
      { id: 'reply', kind: 'reply', agentId: '', waitHours: 24, x: 966, y: 60, prompt: '' },
      { id: 'apply', kind: 'agent', agentId: agents.applier, x: 1268, y: 60, prompt: `My reply tells you which of the postings to apply to ("apply to all" means every one; numbers mean those items; "none" means stop and do nothing). The numbered posting list with each resume link is in the work you were given from the tailoring step.\nFor each chosen posting: open the apply link, fill in the application from my saved details, attach the tailored resume from its Drive link, and submit. If a posting needs something you can't provide (an account, a question only I can answer), skip it and say why.\nThen email me a report with email_send: for each posting whether it was applied to, skipped or failed, with the reason, and the company and apply link.` },
    ];
    return {
      name: 'Summer 2027 internships',
      input: INTERNSHIP_INPUT,
      nodes,
      edges: [{ from: 'find', to: 'tailor' }, { from: 'tailor', to: 'email' }, { from: 'email', to: 'reply' }, { from: 'reply', to: 'apply' }, { from: 'tailor', to: 'apply' }],
      schedule: null,
    };
  },
};

export const FLOW_TEMPLATES: FlowTemplate[] = [INTERNSHIP_TEMPLATE];

/** The agent whose name best fits a role; any agent when none does. */
export function pickAgent(role: { hint: RegExp }, agents: ReadonlyArray<{ id: string; name: string; description?: string }>): string | undefined {
  return (agents.find((agent) => role.hint.test(agent.name)) ?? agents.find((agent) => role.hint.test(agent.description ?? '')) ?? agents[0])?.id;
}
