import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '@main/db/store';
import { AgentMail } from '@main/sandbox/agentmail';
import { AgentFlowService } from '@main/sandbox/flow-service';
import { parseDraft, layout } from '@main/sandbox/flow-draft';
import { FlowInputSchema, flowProblem } from '@shared/agent-flows';
import { INTERNSHIP_TEMPLATE } from '@shared/flow-templates';

const KEY = 'am_test_key_123';
class FakeSocket {
  sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.onclose?.(); }
  push(event: unknown): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'mail-'));
  const calls: Array<{ method: string; url: string; body?: unknown; auth: string | null }> = [];
  const inbox: Array<Record<string, unknown>> = [];
  const fetchFake = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ method, url, ...(init.body !== undefined ? { body: JSON.parse(init.body as string) } : {}), auth: headers.get('authorization') });
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (headers.get('authorization') !== `Bearer ${KEY}`) return reply({ message: 'no' }, 403);
    if (method === 'POST' && url.endsWith('/messages/send')) return reply({ message_id: 'sent-1', thread_id: 'thread-1' });
    if (url.includes('/messages/') && method === 'GET') { const id = decodeURIComponent(url.split('/messages/')[1]!); return reply(inbox.find((m) => m['message_id'] === id) ?? {}); }
    if (url.includes('/messages?')) return reply({ messages: inbox });
    if (url.includes('/inboxes?')) return reply({ inboxes: [{ inbox_id: 'bot@agentmail.to' }] });
    return reply({}, 404);
  }) as unknown as typeof fetch;
  const sockets: FakeSocket[] = [];
  const mail = new AgentMail({ file: join(root, 'agentmail.json'), fetch: fetchFake, socket: () => { const s = new FakeSocket(); sockets.push(s); return s; } });
  return { root, mail, calls, inbox, sockets };
}

describe('AgentMail', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it('checks the key, keeps it in a private file, and only writes to the owner', async () => {
    const { root, mail, calls } = harness(); roots.push(root);
    await expect(mail.connect('nope', 'me@example.com')).rejects.toThrow(/AgentMail API key/);
    await expect(mail.connect(KEY, 'not-an-email')).rejects.toThrow(/email address/);
    const status = await mail.connect(KEY, 'Me@Example.com');
    expect(status).toMatchObject({ configured: true, inbox: 'bot@agentmail.to', owner: 'me@example.com' });
    expect(statSync(join(root, 'agentmail.json')).mode & 0o077).toBe(0);
    await mail.send('Jobs', 'list', 'task-1');
    const sent = calls.find((c) => c.method === 'POST')!;
    expect(sent.body).toMatchObject({ to: 'me@example.com', subject: 'Jobs', text: 'list' });
    expect(mail.threadsFor(['task-1'])).toEqual(['thread-1']);
    mail.stop();
  });

  it('reports a rejected key plainly', async () => {
    const { root, mail } = harness(); roots.push(root);
    await expect(mail.connect('am_wrong', 'me@example.com')).rejects.toThrow('did not accept');
  });

  it('hears live replies once, subscribed to received mail', async () => {
    const { root, mail, sockets } = harness(); roots.push(root);
    await mail.connect(KEY, 'me@example.com');
    const heard: string[] = [];
    mail.onMessage((m) => heard.push(m.text));
    const socket = sockets[0]!;
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'subscribe', inbox_ids: ['bot@agentmail.to'], event_types: ['message.received'] });
    const event = { type: 'event', event_type: 'message.received', event_id: 'e1', message: { message_id: 'r1', thread_id: 'thread-1', from: 'Me <me@example.com>', subject: 'Re: Jobs', extracted_text: 'apply to all', timestamp: '2026-11-18T10:00:00Z' } };
    socket.push(event); socket.push(event);
    expect(heard).toEqual(['apply to all']);
    expect(mail.isOwner({ id: 'r1', threadId: '', from: 'Me <me@example.com>', subject: '', text: '', at: '' })).toBe(true);
    expect(mail.isOwner({ id: 'r2', threadId: '', from: 'evil@example.com', subject: '', text: '', at: '' })).toBe(false);
    mail.stop();
  });
});

describe('a flow that waits for an email reply', () => {
  const roots: string[] = [];
  const stores: SqliteStore[] = [];
  afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  async function setup() {
    const h = harness(); roots.push(h.root);
    await h.mail.connect(KEY, 'me@example.com');
    const store = new SqliteStore(join(h.root, 'f.db')); stores.push(store); await store.migrate();
    const A = randomUUID(); const B = randomUUID();
    const names: Record<string, string> = { [A]: 'Emailer', [B]: 'Applier' };
    const started: Array<{ id: string; objective: string }> = [];
    let clock = new Date('2026-11-18T08:00:00Z');
    const service = new AgentFlowService({
      store, mail: h.mail,
      agents: { get: (id) => (names[id] !== undefined ? { id, name: names[id]! } : undefined), list: () => Object.entries(names).map(([id, name]) => ({ id, name, description: '' })), startingCli: () => 'claude-code', bindThread: () => undefined },
      workspaceId: () => 'ws', now: () => clock,
    });
    service.setTaskCreator(async (input) => { const task = { id: randomUUID() } as never; started.push({ id: (task as { id: string }).id, objective: input.objective }); input.onCreated?.(task); return task; });
    service.setReplyReader((id) => `said by ${started.findIndex((s) => s.id === id)}`);
    const flow = service.save({
      name: 'Digest', input: '',
      nodes: [{ id: 'mail', agentId: A, prompt: 'email me', x: 0, y: 0 }, { id: 'wait', kind: 'reply', agentId: '', waitHours: 2, prompt: '', x: 300, y: 0 }, { id: 'apply', agentId: B, prompt: 'do what I said', x: 600, y: 0 }],
      edges: [{ from: 'mail', to: 'wait' }, { from: 'wait', to: 'apply' }], schedule: null,
    });
    return { ...h, service, started, flow, setClock: (d: Date) => { clock = d; } };
  }

  const reply = (text: string, extra: Record<string, unknown> = {}) => ({ id: `m-${text}`, threadId: 'thread-1', from: 'me@example.com', subject: 'Re: Jobs', text, at: '2026-11-18T09:00:00Z', ...extra });

  it('pauses at the reply step and carries the answer to the next step', async () => {
    const { service, started, flow, mail } = await setup();
    await service.run(flow.id, 'manual');
    await mail.send('Jobs', 'reply please', started[0]!.id);
    await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
    expect(service.runs(flow.id)[0]!.nodes.find((n) => n.nodeId === 'wait')).toMatchObject({ status: 'running', note: expect.stringContaining('Waiting') });
    expect(started).toHaveLength(1);
    // A stranger's mail, and the owner's mail on another thread, don't answer it.
    await service.mailArrived(reply('apply to all', { from: 'evil@example.com' }));
    await service.mailArrived(reply('apply to all', { threadId: 'other' }));
    expect(started).toHaveLength(1);
    await service.mailArrived(reply('apply to all', { at: '2026-11-18T08:30:00Z' }));
    expect(started).toHaveLength(2);
    expect(started[1]!.objective).toContain('The user replied by email');
    expect(started[1]!.objective).toContain('apply to all');
    await service.taskSettled({ id: started[1]!.id, state: 'COMPLETED' });
    expect(service.runs(flow.id)[0]!.status).toBe('done');
  });

  it('keeps waiting across a restart and gives up after the wait time', async () => {
    const { service, started, flow, mail, setClock } = await setup();
    await service.run(flow.id, 'manual');
    await mail.send('Jobs', 'x', started[0]!.id);
    await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
    await service.reconcile();
    expect(service.runs(flow.id)[0]!.nodes.find((n) => n.nodeId === 'wait')!.status).toBe('running');
    setClock(new Date('2026-11-18T11:00:00Z'));
    await service.tick();
    const run = service.runs(flow.id)[0]!;
    expect(run.status).toBe('failed');
    expect(Object.fromEntries(run.nodes.map((n) => [n.nodeId, n.status]))).toEqual({ mail: 'done', wait: 'failed', apply: 'skipped' });
    expect(run.nodes.find((n) => n.nodeId === 'wait')!.note).toContain('2 hours');
  });

  it('finds a reply that came in while the app was closed', async () => {
    const { service, started, flow, mail, inbox } = await setup();
    await service.run(flow.id, 'manual');
    await mail.send('Jobs', 'x', started[0]!.id);
    await service.taskSettled({ id: started[0]!.id, state: 'COMPLETED' });
    inbox.push({ message_id: 'late', thread_id: 'thread-1', from: 'me@example.com', subject: 'Re', extracted_text: '1, 3', timestamp: '2026-11-18T09:00:00Z' });
    await service.tick();
    expect(started).toHaveLength(2);
    expect(started[1]!.objective).toContain('1, 3');
  });
});

describe('describing a flow', () => {
  const agents = [{ id: randomUUID(), name: 'Scraper', description: '' }, { id: randomUUID(), name: 'Resume Tailor', description: '' }];
  const reply = (steps: unknown, extra: Record<string, unknown> = {}) => `\`\`\`json\n${JSON.stringify({ name: 'Jobs', input: 'backend roles', steps, schedule: { cron: '0 9,17 * * *' }, ...extra })}\n\`\`\``;

  it('turns a model answer into a laid-out flow with the schedule off', () => {
    const out = parseDraft(reply([
      { key: 'a', kind: 'agent', agent: 'scraper', prompt: 'find {{input}}', after: [] },
      { key: 'b', kind: 'agent', agent: 'Resume Tailor', prompt: 'tailor', after: ['a'] },
      { key: 'c', kind: 'reply', waitHours: 6, after: ['b'] },
    ]), agents, true);
    if ('error' in out) throw new Error(out.error);
    expect(out.flow.nodes.map((n) => [n.kind, n.x])).toEqual([['agent', 60], ['agent', 362], ['reply', 664]]);
    expect(out.flow.edges).toEqual([{ from: 'step-1', to: 'step-2' }, { from: 'step-2', to: 'step-3' }]);
    expect(out.flow.nodes[2]).toMatchObject({ waitHours: 6, agentId: '' });
    expect(out.flow.schedule).toEqual({ cron: '0 9,17 * * *', enabled: false });
    expect(FlowInputSchema.safeParse(out.flow).success).toBe(true);
  });

  it('refuses answers it cannot trust', () => {
    expect(parseDraft('sorry', agents, true)).toHaveProperty('error');
    expect(parseDraft(reply([{ key: 'a', kind: 'agent', agent: 'Ghost', prompt: 'x', after: [] }]), agents, true)).toHaveProperty('error');
    expect(parseDraft(reply([{ key: 'a', kind: 'reply', after: [] }]), agents, false)).toHaveProperty('error');
    expect(parseDraft(reply([{ key: 'a', kind: 'agent', agent: 'Scraper', prompt: '', after: ['b'] }, { key: 'b', kind: 'agent', agent: 'Scraper', prompt: '', after: ['a'] }]), agents, true)).toHaveProperty('error');
  });

  it('puts parallel steps in one column', () => {
    const places = layout([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }]);
    expect(places.get('a')!.x).toBe(places.get('b')!.x);
    expect(places.get('a')!.y).not.toBe(places.get('b')!.y);
    expect(places.get('c')!.x).toBeGreaterThan(places.get('a')!.x);
  });
});

describe('the internship template', () => {
  it('is a sound flow that waits for the reply before applying', () => {
    const made = INTERNSHIP_TEMPLATE.build({ scraper: randomUUID(), tailor: randomUUID(), applier: randomUUID() });
    expect(flowProblem(made.nodes, made.edges)).toBeUndefined();
    expect(FlowInputSchema.safeParse(made).success).toBe(true);
    expect(made.nodes.map((n) => n.id)).toEqual(['find', 'tailor', 'email', 'reply', 'apply']);
    expect(made.nodes[0]!.prompt).toContain('{{input}}');
    expect(made.nodes[0]!.prompt).toContain('SimplifyJobs/Summer2027-Internships');
    expect(made.input).toContain('Roles:');
  });
});
