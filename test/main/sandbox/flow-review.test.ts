import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '@main/db/store';
import { AgentMail } from '@main/sandbox/agentmail';
import { AgentFlowService } from '@main/sandbox/flow-service';
import { FlowInputSchema, flowProblem } from '@shared/agent-flows';

// Review steps and branch conditions: a review waits for the user's verdict
// by email, sends the work back to the step it reviews (bounded by
// maxRounds), and the arrows out of a reply/review step continue only when
// their condition fired.

const KEY = 'am_test_key_123';
class FakeSocket {
  sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.onclose?.(); }
  push(event: unknown): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'review-'));
  const inbox: Array<Record<string, unknown>> = [];
  const fetchFake = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (headers.get('authorization') !== `Bearer ${KEY}`) return reply({ message: 'no' }, 403);
    if (method === 'POST' && url.endsWith('/messages/send')) return reply({ message_id: 'sent-1', thread_id: 'thread-1' });
    if (url.includes('/messages/') && method === 'GET') { const id = decodeURIComponent(url.split('/messages/')[1]!); return reply(inbox.find((m) => m['message_id'] === id) ?? {}); }
    if (url.includes('/messages?')) return reply({ messages: inbox });
    if (url.includes('/inboxes?')) return reply({ inboxes: [{ inbox_id: 'bot@agentmail.to' }] });
    return reply({}, 404);
  }) as unknown as typeof fetch;
  const mail = new AgentMail({ file: join(root, 'agentmail.json'), fetch: fetchFake, socket: () => new FakeSocket() });
  return { root, mail, inbox };
}

describe('review steps and branch conditions', () => {
  const roots: string[] = [];
  const stores: SqliteStore[] = [];
  afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  describe('validation', () => {
    const nodes = [
      { id: 'a', kind: 'agent' as const },
      { id: 'r', kind: 'review' as const, loopTo: 'a' },
      { id: 'p', kind: 'agent' as const },
      { id: 'f', kind: 'agent' as const },
      { id: 'w', kind: 'reply' as const },
    ];
    const edges = [
      { from: 'a', to: 'r' },
      { from: 'r', to: 'p', when: { label: 'approve' } },
      { from: 'r', to: 'f', when: { label: 'revise', match: 'fix|again' } },
      { from: 'a', to: 'w' },
      { from: 'w', to: 'p', when: { label: 'later', match: 'ship' } },
    ];

    it('accepts a review loop and labelled branches', () => {
      expect(flowProblem(nodes, edges)).toBeUndefined();
    });

    it('refuses branches on plain steps, bad patterns and wrong review labels', () => {
      expect(flowProblem(nodes, [{ from: 'a', to: 'r' }, { from: 'a', to: 'p', when: { label: 'x', match: 'y' } }])).toMatch(/reply or review/);
      expect(flowProblem(nodes, [{ from: 'a', to: 'r' }, { from: 'r', to: 'p', when: { label: 'approve', match: '(["' } }])).toMatch(/valid pattern/);
      expect(flowProblem(nodes, [{ from: 'a', to: 'r' }, { from: 'r', to: 'p', when: { label: 'maybe' } }])).toMatch(/“approve” or “revise”/);
      expect(flowProblem(nodes, [{ from: 'a', to: 'r' }, { from: 'a', to: 'w' }, { from: 'w', to: 'p', when: { label: 'yes' } }])).toMatch(/pattern to match/);
    });

    it('only lets a review step send work back, and only to a step it waits on', () => {
      expect(flowProblem([{ id: 'a', kind: 'agent' as const, loopTo: 'b' }, { id: 'b', kind: 'agent' as const }], [])).toMatch(/Only a review/);
      expect(flowProblem([{ id: 'r', kind: 'review' as const, loopTo: 'ghost' }], [])).toMatch(/exists/);
      expect(flowProblem(nodes, [{ from: 'r', to: 'p' }])).toMatch(/directly/);
      // Sending back along a real arrow keeps the graph a loop-free DAG.
      expect(flowProblem(nodes, [...edges, { from: 'p', to: 'a' }])).toMatch(/loop/);
    });

    it('the input schema takes review fields and rejects them on other steps', () => {
      const base = {
        name: 'Review', input: '',
        nodes: [
          { id: 'a', kind: 'agent' as const, agentId: randomUUID(), prompt: 'draft', x: 0, y: 0 },
          { id: 'r', kind: 'review' as const, agentId: '', waitHours: 6, loopTo: 'a', maxRounds: 2, onTimeout: 'approve' as const, prompt: '', x: 1, y: 0 },
        ],
        edges: [{ from: 'a', to: 'r' }],
        schedule: null,
      };
      expect(FlowInputSchema.safeParse(base).success).toBe(true);
      expect(FlowInputSchema.safeParse({ ...base, nodes: [{ ...base.nodes[0]!, loopTo: 'r', maxRounds: 2 }] }).success).toBe(false);
      expect(FlowInputSchema.safeParse({ ...base, nodes: [{ ...base.nodes[1]!, kind: 'reply' as const, loopTo: 'a' }] }).success).toBe(false);
      expect(FlowInputSchema.safeParse({ ...base, edges: [{ from: 'r', to: 'a' }] }).success).toBe(true);
    });
  });

  describe('running a flow with a review', () => {
    async function setup() {
      const h = harness(); roots.push(h.root);
      await h.mail.connect(KEY, 'me@example.com');
      const store = new SqliteStore(join(h.root, 'f.db')); stores.push(store); await store.migrate();
      const A = randomUUID(); const B = randomUUID();
      const names: Record<string, string> = { [A]: 'Writer', [B]: 'Publisher' };
      const started: Array<{ id: string; objective: string }> = [];
      let clock = new Date('2026-11-18T08:00:00Z');
      const makeService = () => new AgentFlowService({
        store, mail: h.mail,
        agents: { get: (id) => (names[id] !== undefined ? { id, name: names[id]! } : undefined), list: () => Object.entries(names).map(([id, name]) => ({ id, name, description: '' })), startingCli: () => 'claude-code', bindThread: () => undefined },
        workspaceId: () => 'ws', now: () => clock,
      });
      const service = makeService();
      service.setTaskCreator(async (input) => { const task = { id: randomUUID() } as never; started.push({ id: (task as { id: string }).id, objective: input.objective }); input.onCreated?.(task); return task; });
      service.setReplyReader(() => 'a draft');
      return { ...h, service, makeService, store, started, A, B, setClock: (d: Date) => { clock = d; } };
    }

    const reply = (text: string, extra: Record<string, unknown> = {}) => ({ id: `m-${text}`, threadId: 'thread-1', from: 'me@example.com', subject: 'Re: Draft', text, at: '2026-11-18T09:00:00Z', ...extra });

    async function agentReview() {
      const h = await setup();
      const flow = h.service.save({ name: 'Agent routing', input: '', schedule: null,
        nodes: [
          { id: 'd', agentId: h.A, prompt: 'draft', x: 0, y: 0 },
          { id: 'c', agentId: h.A, prompt: 'check', x: 100, y: 0 },
          { id: 'r', kind: 'review', agentId: '', cli: 'codex', model: 'chosen-model', maxRounds: 2, prompt: '', x: 200, y: 0 },
          { id: 'p', agentId: h.B, prompt: 'publish', x: 300, y: 0 },
        ], edges: [{ from: 'd', to: 'c' }, { from: 'c', to: 'r' }, { from: 'r', to: 'p' }],
      });
      await h.service.run(flow.id, 'manual');
      await h.service.taskSettled({ id: h.started[0]!.id, state: 'COMPLETED' });
      await h.mail.send('Draft', 'check this', h.started[1]!.id);
      await h.service.taskSettled({ id: h.started[1]!.id, state: 'COMPLETED' });
      return { ...h, flow };
    }

    it('uses the chosen routing CLI/model, persists a new DAG and hands structured feedback to the revising task', async () => {
      const { service, flow, started, mail, store } = await agentReview();
      const calls: Array<{ prompt: string; cli: string; model?: string }> = [];
      service.setFeedbackRouter(async (input) => {
        calls.push(input);
        return JSON.stringify({ route: { type: 'decision', next: [calls.length === 1 ? 'd' : 'p'] }, feedback: { summary: 'Reviewer decision', instructions: ['Make the introduction shorter'] } });
      });
      await Promise.all([service.mailArrived(reply('shorten the intro')), service.mailArrived(reply('shorten the intro'))]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ cli: 'codex', model: 'chosen-model' });
      expect(calls[0]!.prompt).toContain('"dag"');
      expect(calls[0]!.prompt).toContain('shorten the intro');
      expect(started).toHaveLength(3);
      expect(started[2]!.objective).toContain('Make the introduction shorter');
      expect(started[2]!.objective).toContain('"instructions"');
      const row = store.db.prepare('SELECT definition FROM agent_flow_runs WHERE flow_id = ?').get(flow.id) as { definition: string };
      expect(JSON.parse(row.definition).nodes.some((n: { kind?: string }) => n.kind === 'rewind')).toBe(true);
      expect(service.get(flow.id)!.nodes).toHaveLength(4);
      await service.taskSettled({ id: started[2]!.id, state: 'COMPLETED' });
      await mail.send('Revision', 'revised', started[3]!.id);
      await service.taskSettled({ id: started[3]!.id, state: 'COMPLETED' });
      await service.mailArrived(reply('approved', { id: 'approval-2' }));
      expect(started).toHaveLength(5);
      await service.taskSettled({ id: started[4]!.id, state: 'COMPLETED' });
      expect(service.runs(flow.id)[0]!.status).toBe('done');
    });

    it('recovers persisted feedback analysis in a fresh service after restart', async () => {
      const { store, flow, makeService, service } = await agentReview();
      const runId = service.runs(flow.id)[0]!.id;
      store.db.prepare("UPDATE agent_flow_run_nodes SET pending_input = 'Please revise', note = 'Analyzing reviewer feedback.' WHERE run_id = ? AND node_id = 'r'").run(runId);
      const recovered = makeService();
      const objectives: string[] = [];
      recovered.setTaskCreator(async (input) => { const task = { id: randomUUID() } as never; objectives.push(input.objective); input.onCreated?.(task); return task; });
      recovered.setFeedbackRouter(async () => JSON.stringify({ route: { type: 'decision', next: ['d'] }, feedback: { summary: 'Revision', instructions: ['Use shorter sentences'] } }));
      await recovered.reconcile();
      expect(objectives).toHaveLength(1);
      expect(objectives[0]).toContain('Use shorter sentences');
      expect(recovered.runs(flow.id)[0]!.status).toBe('running');
    });

    it('fails at the revision limit instead of approving the rejected work', async () => {
      const { store, service, flow, started } = await agentReview();
      const runId = service.runs(flow.id)[0]!.id;
      store.db.prepare("UPDATE agent_flow_run_nodes SET rounds = 2 WHERE run_id = ? AND node_id = 'r'").run(runId);
      service.setFeedbackRouter(async () => JSON.stringify({ route: { type: 'decision', next: ['d'] }, feedback: { summary: 'Not approved', instructions: ['Fix it'] } }));
      await service.mailArrived(reply('not approved'));
      expect(service.runs(flow.id)[0]!.status).toBe('failed');
      expect(started).toHaveLength(2);
      expect(service.runs(flow.id)[0]!.nodes.find((n) => n.nodeId === 'r')!.note).toContain('maximum number');
    });

    it('passes structured instructions to the selected forward step', async () => {
      const { service, flow, started } = await agentReview();
      service.setFeedbackRouter(async () => JSON.stringify({ route: { type: 'decision', next: ['p'] }, feedback: { summary: 'Approved', instructions: ['Publish with the supplied title'] } }));
      await service.mailArrived(reply('approved'));
      expect(started).toHaveLength(3);
      expect(started[2]!.objective).toContain('Publish with the supplied title');
      await service.taskSettled({ id: started[2]!.id, state: 'COMPLETED' });
      expect(service.runs(flow.id)[0]!.status).toBe('done');
    });

    it('continues through a join when the other decision branch was not selected', async () => {
      const { service, A, started, mail } = await setup();
      const flow = service.save({ name: 'Branch join', input: '', schedule: null,
        nodes: ['draft', 'review', 'publish', 'archive', 'join'].map((id) => ({ id, agentId: id === 'review' ? '' : A, ...(id === 'review' ? { kind: 'review' as const, cli: 'codex' } : {}), prompt: id, x: 0, y: 0 })),
        edges: [{ from: 'draft', to: 'review' }, { from: 'review', to: 'publish' }, { from: 'review', to: 'archive' }, { from: 'publish', to: 'join' }, { from: 'archive', to: 'join' }],
      });
      service.setFeedbackRouter(async () => JSON.stringify({ route: { type: 'decision', next: ['publish'] }, feedback: { summary: 'Approved', instructions: ['Publish'] } }));
      await service.run(flow.id, 'manual');
      await mail.send('Draft', 'review', started[0]!.id);
      await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
      await service.mailArrived(reply('publish'));
      await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
      expect(started).toHaveLength(3);
      await service.taskSettled({ id: started[2]!.id, state: 'COMPLETED' });
      expect(service.runs(flow.id)[0]!.nodes.find((n) => n.nodeId === 'join')!.status).toBe('done');
    });

    it('preserves feedback from two reviews that select the same waiting step', async () => {
      const { service, A, B, started, mail } = await setup();
      const flow = service.save({ name: 'Two reviews', input: '', schedule: null,
        nodes: [
          { id: 'a1', agentId: A, prompt: 'first draft', x: 0, y: 0 },
          { id: 'a2', agentId: A, prompt: 'second draft', x: 0, y: 100 },
          { id: 'r1', kind: 'review', agentId: '', cli: 'codex', prompt: '', x: 100, y: 0 },
          { id: 'r2', kind: 'review', agentId: '', cli: 'codex', prompt: '', x: 100, y: 100 },
          { id: 'p', agentId: B, prompt: 'combine and publish', x: 200, y: 50 },
        ],
        edges: [{ from: 'a1', to: 'r1' }, { from: 'a2', to: 'r2' }, { from: 'r1', to: 'p' }, { from: 'r2', to: 'p' }],
      });
      let call = 0;
      service.setFeedbackRouter(async () => {
        call += 1;
        return JSON.stringify({ route: { type: 'decision', next: ['p'] }, feedback: { summary: `Review ${call}`, instructions: [`Instruction ${call}`] } });
      });
      await service.run(flow.id, 'manual');
      await mail.send('First', 'one', started[0]!.id);
      await mail.send('Second', 'two', started[1]!.id);
      await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
      await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
      await service.mailArrived(reply('first approved', { id: 'review-one' }));
      await service.mailArrived(reply('second approved', { id: 'review-two' }));
      expect(started).toHaveLength(3);
      expect(started[2]!.objective).toContain('Instruction 1');
      expect(started[2]!.objective).toContain('Instruction 2');
    });

    it('fails visibly on an invalid routing decision without starting downstream work', async () => {
      const { service, flow, started } = await agentReview();
      service.setFeedbackRouter(async () => '{"route":{"type":"decision","next":["ghost"]},"feedback":{"summary":"x","instructions":["x"]}}');
      await service.mailArrived(reply('changes'));
      expect(started).toHaveLength(2);
      expect(service.runs(flow.id)[0]!.status).toBe('failed');
      expect(service.runs(flow.id)[0]!.nodes.find((n) => n.nodeId === 'r')!.note).toMatch(/Feedback routing failed/);
    });

    it('sends the work back on revise, then continues on approve', async () => {
      const { service, started, mail, A, B } = await setup();
      const flow = service.save({
        name: 'Draft then review', input: '',
        nodes: [
          { id: 'd', agentId: A, prompt: 'draft it', x: 0, y: 0 },
          { id: 'r', kind: 'review', agentId: '', waitHours: 2, maxRounds: 2, loopTo: 'd', prompt: '', x: 300, y: 0 },
          { id: 'p', agentId: B, prompt: 'publish', x: 600, y: 0 },
        ],
        edges: [{ from: 'd', to: 'r' }, { from: 'r', to: 'p', when: { label: 'approve' } }],
        schedule: null,
      });
      await service.run(flow.id, 'manual');
      await mail.send('Draft', 'look at this', started[0]!.id);
      await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
      expect(service.runs(flow.id)[0]!.nodes.find((n) => n.nodeId === 'r')).toMatchObject({ status: 'running', note: expect.stringContaining('Waiting') });

      // "revise" sends the reviewed step back with the feedback attached.
      await service.mailArrived(reply('too long, fix the intro'));
      let run = service.runs(flow.id)[0]!;
      expect(run.nodes.find((n) => n.nodeId === 'r')).toMatchObject({ status: 'waiting', rounds: 1, note: 'Sent back for round 1 of changes.' });
      expect(started).toHaveLength(2);
      expect(started[1]!.objective).toContain('Reviewer feedback from the last round');
      expect(started[1]!.objective).toContain('too long, fix the intro');
      expect(run.nodes.find((n) => n.nodeId === 'p')!.status).toBe('waiting');

      // The re-run finishes — it emailed the new draft like any agent step —
      // and the review waits for the next verdict.
      await mail.send('Draft', 'version two', started[1]!.id);
      await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
      expect(service.runs(flow.id)[0]!.nodes.find((n) => n.nodeId === 'r')).toMatchObject({ status: 'running', note: expect.stringContaining('Waiting') });

      // "approve" records the verdict and lets the approve arrow continue.
      await service.mailArrived(reply('looks good'));
      expect(started).toHaveLength(3);
      run = service.runs(flow.id)[0]!;
      expect(run.nodes.find((n) => n.nodeId === 'r')).toMatchObject({ status: 'done', branch: 'approve', rounds: 2 });
      expect(started[2]!.objective).toContain('The user replied by email');
      await service.taskSettled({ id: started[2]!.id, state: 'COMPLETED' });
      expect(service.runs(flow.id)[0]!.status).toBe('done');
    });

    it('proceeds anyway once the feedback rounds are used up', async () => {
      const { service, started, mail, A, B } = await setup();
      const flow = service.save({
        name: 'Bounded', input: '',
        nodes: [
          { id: 'd', agentId: A, prompt: 'draft', x: 0, y: 0 },
          { id: 'r', kind: 'review', agentId: '', waitHours: 2, maxRounds: 1, loopTo: 'd', prompt: '', x: 300, y: 0 },
          { id: 'p', agentId: B, prompt: 'publish', x: 600, y: 0 },
        ],
        edges: [{ from: 'd', to: 'r' }, { from: 'r', to: 'p', when: { label: 'approve' } }],
        schedule: null,
      });
      await service.run(flow.id, 'manual');
      await mail.send('Draft', 'x', started[0]!.id);
      await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
      await service.mailArrived(reply('not approved, fix it'));
      const run = service.runs(flow.id)[0]!;
      expect(run.nodes.find((n) => n.nodeId === 'r')).toMatchObject({
        status: 'done', branch: 'approve', rounds: 1, note: '1 rounds of feedback came back; proceeding anyway.',
      });
      // No extra pass: the one round is used, so publish starts straight away.
      expect(started).toHaveLength(2);
      await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
      expect(service.runs(flow.id)[0]!.status).toBe('done');
    });

    it('proceeds as approved when no review comes in time', async () => {
      const { service, started, mail, A, B, setClock } = await setup();
      const flow = service.save({
        name: 'Silence is approval', input: '',
        nodes: [
          { id: 'd', agentId: A, prompt: 'draft', x: 0, y: 0 },
          { id: 'r', kind: 'review', agentId: '', waitHours: 1, onTimeout: 'approve', prompt: '', x: 300, y: 0 },
          { id: 'p', agentId: B, prompt: 'publish', x: 600, y: 0 },
        ],
        edges: [{ from: 'd', to: 'r' }, { from: 'r', to: 'p', when: { label: 'approve' } }],
        schedule: null,
      });
      await service.run(flow.id, 'manual');
      await mail.send('Draft', 'x', started[0]!.id);
      await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
      setClock(new Date('2026-11-18T10:30:00Z'));
      await service.tick();
      const run = service.runs(flow.id)[0]!;
      expect(run.nodes.find((n) => n.nodeId === 'r')).toMatchObject({ status: 'done', branch: 'approve', note: expect.stringContaining('proceeding as approved') });
      expect(started).toHaveLength(2);
      await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
      expect(service.runs(flow.id)[0]!.status).toBe('done');
    });
  });

  describe('branching on what came back', () => {
    async function setup() {
      const h = harness(); roots.push(h.root);
      await h.mail.connect(KEY, 'me@example.com');
      const store = new SqliteStore(join(h.root, 'f.db')); stores.push(store); await store.migrate();
      const A = randomUUID(); const B = randomUUID(); const C = randomUUID();
      const names: Record<string, string> = { [A]: 'Asker', [B]: 'Goer', [C]: 'Halter' };
      const started: Array<{ id: string; objective: string }> = [];
      const service = new AgentFlowService({
        store, mail: h.mail,
        agents: { get: (id) => (names[id] !== undefined ? { id, name: names[id]! } : undefined), list: () => Object.entries(names).map(([id, name]) => ({ id, name, description: '' })), startingCli: () => 'claude-code', bindThread: () => undefined },
        workspaceId: () => 'ws', now: () => new Date('2026-11-18T08:00:00Z'),
      });
      service.setTaskCreator(async (input) => { const task = { id: randomUUID() } as never; started.push({ id: (task as { id: string }).id, objective: input.objective }); input.onCreated?.(task); return task; });
      service.setReplyReader(() => '');
      const flow = service.save({
        name: 'Two paths', input: '',
        nodes: [
          { id: 'a', agentId: A, prompt: 'ask', x: 0, y: 0 },
          { id: 'w', kind: 'reply', agentId: '', waitHours: 2, prompt: '', x: 300, y: 0 },
          { id: 'x', agentId: B, prompt: 'go', x: 600, y: 0 },
          { id: 'y', agentId: C, prompt: 'halt', x: 600, y: 120 },
        ],
        edges: [
          { from: 'a', to: 'w' },
          { from: 'w', to: 'x', when: { label: 'ok', match: 'please go' } },
          { from: 'w', to: 'y', when: { label: 'stop', match: 'halt' } },
        ],
        schedule: null,
      });
      return { ...h, service, started, flow };
    }

    const reply = (text: string) => ({ id: `m-${text}`, threadId: 'thread-1', from: 'me@example.com', subject: 'Re: Ask', text, at: '2026-11-18T09:00:00Z' });

    it('continues only down the matching arrow and finishes the run', async () => {
      const { service, started, mail, flow } = await setup();
      await service.run(flow.id, 'manual');
      await mail.send('Ask', 'answer me', started[0]!.id);
      await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
      await service.mailArrived(reply('please go ahead'));
      expect(started).toHaveLength(2);
      const run = service.runs(flow.id)[0]!;
      expect(Object.fromEntries(run.nodes.map((n) => [n.nodeId, n.status]))).toEqual({ a: 'done', w: 'done', x: 'running', y: 'skipped' });
      expect(run.nodes.find((n) => n.nodeId === 'y')!.note).toBe('No branch led here.');
      expect(run.nodes.find((n) => n.nodeId === 'w')!.branch).toBe('ok');
      await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
      // A step skipped because no branch led to it does not fail the run.
      expect(service.runs(flow.id)[0]!.status).toBe('done');
    });

    it('skips both paths when nothing matches, without failing the run', async () => {
      const { service, started, mail, flow } = await setup();
      await service.run(flow.id, 'manual');
      await mail.send('Ask', 'answer me', started[0]!.id);
      await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
      await service.mailArrived(reply('hmm, maybe later'));
      expect(started).toHaveLength(1);
      const run = service.runs(flow.id)[0]!;
      expect(run.nodes.find((n) => n.nodeId === 'w')!.status).toBe('done');
      expect(run.nodes.find((n) => n.nodeId === 'w')!.branch).toBeUndefined();
      expect(run.nodes.find((n) => n.nodeId === 'x')!.status).toBe('skipped');
      expect(run.nodes.find((n) => n.nodeId === 'y')!.status).toBe('skipped');
      expect(service.runs(flow.id)[0]!.status).toBe('done');
    });
  });
});
