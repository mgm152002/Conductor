import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { MemoryEngine } from '@main/domain/memory-engine';
import { PermissionService } from '@main/domain/permission-service';
import { ConnectorService } from '@main/connectors/connector-service';
import { IngestionWorker } from '@main/connectors/ingestion-worker';
import { ConnectorRuntime } from '@main/connectors/connector-runtime';
import { createMemoryIngestionSink } from '@main/connectors/memory-ingestion-sink';
import { NetworkAccess } from '@main/connectors/network-access';
import { EmailConnectorLifecycle, renderMessage, type MailClient } from '@main/connectors/email-connector';
import { CalendarConnectorLifecycle } from '@main/connectors/calendar-connector';
import { SlackConnectorLifecycle, type SlackCall } from '@main/connectors/slack-connector';
import { parseCalendar } from '@main/connectors/ics';
import { SecretStore, ownershipGate, type KeychainWriter } from '@main/secrets/secret-store';
import { SecretsProxy } from '@main/secrets/secrets-proxy';
import { SelfLearningEngine } from '@main/domain/self-learning-service';
import { LearningLoop } from '@main/domain/learning-loop';
import { ProactiveAssistant } from '@main/domain/proactive-assistant-service';
import { ProactiveSignals, connectorSources, suggestionExecutor } from '@main/domain/proactive-signals';
import { RecordingSuggestionEmitter } from '@main/orchestrator/suggestion-emitter';
import { WorkspaceService } from '@main/domain/workspace-service';
import type { Task } from '@shared/domain';
import { mockMem0 } from '../helpers/mem0';

let dir: string;
let store: SqliteStore;
let audit: AuditLog;
let keychain: Map<string, string>;
let secrets: SecretStore;
let consented: Set<string>;
let network: NetworkAccess;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-src-'));
  store = new SqliteStore(join(dir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  keychain = new Map();
  const writer: KeychainWriter = {
    write: async ({ account }, value) => { keychain.set(account, value); },
    remove: async ({ account }) => { keychain.delete(account); },
  };
  secrets = new SecretStore(store, audit, writer);
  consented = new Set();
  const proxy = new SecretsProxy({ resolve: (id) => keychain.get(id) }, ownershipGate(secrets), audit);
  network = new NetworkAccess(proxy, { require: (provider) => { if (!consented.has(provider)) throw new Error(`No consent for ${provider}`); } });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const RAW_EMAIL = Buffer.from([
  'From: Ada <ada@example.com>', 'To: me@example.com', 'Subject: Quarterly numbers', 'Date: Fri, 23 Oct 2026 10:00:00 +0000',
  'Message-ID: <abc@example.com>', 'Content-Type: text/plain; charset=utf-8', '', 'Can you send the Q3 revenue figures by Monday?', '',
].join('\r\n'));

function fakeMail(seen: { pass?: string | undefined; ranges: string[] }, uids: number[], uidValidity = '7'): MailClient {
  return {
    connect: async () => undefined,
    open: async () => ({ uidValidity, uidNext: Math.max(0, ...uids) + 1, exists: uids.length }),
    async *fetch(range) {
      seen.ranges.push(range);
      const [from, to] = range.split(':').map(Number) as [number, number];
      for (const uid of uids) if (uid >= from && uid <= to) yield { uid, source: RAW_EMAIL, internalDate: new Date('2026-10-23T10:00:00Z') };
    },
    close: async () => undefined,
  };
}

function runtimeWith(lifecycles: ConstructorParameters<typeof IngestionWorker>[0]['lifecycles'], onSynced?: ConstructorParameters<typeof ConnectorRuntime>[0]['onSynced']) {
  const connectors = new ConnectorService(store, audit);
  const memory = new MemoryEngine(store, Date.now, mockMem0().client);
  const worker = new IngestionWorker({ connectors, audit, lifecycles, sink: createMemoryIngestionSink(memory) });
  const runtime = new ConnectorRuntime({
    connectors, worker, flushMemories: () => memory.synchronize(), syncEnabled: () => false, workspaceExists: () => true, watchFactory: null, intervalMs: 0,
    secrets, grantConsent: (p) => { consented.add(p); }, ...(onSynced ? { onSynced } : {}),
  });
  return { connectors, runtime };
}

describe('secrets', () => {
  it('only releases a secret to the integration that owns it', async () => {
    const secret = await secrets.put({ label: 'token', value: 's3cret', owner: 'connector:a' });
    const gate = ownershipGate(secrets);
    expect(gate.allows({ adapterId: 'connector:a', secretId: secret.id, target: 'x' })).toBe(true);
    expect(gate.allows({ adapterId: 'connector:b', secretId: secret.id, target: 'x' })).toBe(false);
    expect(JSON.stringify(secrets.list())).not.toContain('s3cret');
    await secrets.delete(secret.id);
    expect(keychain.size).toBe(0);
  });
});

describe('email connector (IMAP)', () => {
  it('stores the password in the keychain, substitutes it only at egress, and indexes new mail incrementally', async () => {
    const seen = { ranges: [] as string[], pass: undefined as string | undefined };
    let uids = [1, 2, 3];
    const email = new EmailConnectorLifecycle(network, (credentials) => { seen.pass = credentials.pass; return fakeMail(seen, uids); });
    const { runtime, connectors } = runtimeWith({ email });
    const view = await runtime.createEmail({ name: 'Work', host: 'imap.example.com', port: 993, secure: true, user: 'me@example.com', password: 'app-pass' });
    await runtime.sync(view.id, 'event');
    expect(seen.pass).toBe('app-pass');
    expect(connectors.get(view.id)!.config.email!.secretId).toMatch(/^sec_/);
    expect(JSON.stringify(connectors.get(view.id)!.config)).not.toContain('app-pass');
    expect(consented.has('email:imap.example.com')).toBe(true);
    expect(runtime.view(view.id).itemCount).toBe(1); // identical bodies dedupe by content hash
    expect(JSON.stringify(audit.list())).not.toContain('app-pass');

    uids = [1, 2, 3, 4];
    seen.ranges.length = 0;
    await runtime.sync(view.id, 'event');
    expect(seen.ranges[0]).toBe('4:4');

    await runtime.delete(view.id);
    expect(keychain.size).toBe(0);
  });

  it('rolls back the credential and connector when login fails', async () => {
    const email = new EmailConnectorLifecycle(network, () => ({ ...fakeMail({ ranges: [] }, []), connect: async () => { throw new Error('AUTHENTICATIONFAILED'); } }));
    const { runtime, connectors } = runtimeWith({ email });
    await expect(runtime.createEmail({ name: 'Bad', host: 'imap.example.com', port: 993, secure: true, user: 'me@example.com', password: 'x' })).rejects.toThrow(/AUTHENTICATIONFAILED/);
    expect(connectors.list()).toHaveLength(0);
    expect(keychain.size).toBe(0);
  });

  it('renders messages as readable text', async () => {
    const rendered = await renderMessage(RAW_EMAIL);
    expect(rendered.text).toContain('From: "Ada" <ada@example.com>');
    expect(rendered.text).toContain('Subject: Quarterly numbers');
    expect(rendered.text).toContain('Q3 revenue figures');
  });
});

describe('calendar connector (iCalendar)', () => {
  const ICS = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:standup', 'SUMMARY:Team standup', 'DTSTART;TZID=America/New_York:20261026T090000', 'DTEND;TZID=America/New_York:20261026T091500',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4', 'EXDATE;TZID=America/New_York:20261028T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:offsite', 'SUMMARY:Offsite\\, day 1', 'DTSTART;VALUE=DATE:20261030', 'DESCRIPTION:Bring laptops\\nand', ' badges', 'LOCATION:HQ', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('parses time zones, all-day events, escapes, folding and weekly recurrences with exceptions', () => {
    const events = parseCalendar(ICS, { from: new Date('2026-10-20T00:00:00Z'), to: new Date('2026-12-31T00:00:00Z') });
    const standups = events.filter((e) => e.uid === 'standup').map((e) => e.start.toISOString());
    expect(standups).toEqual(['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-04T14:00:00.000Z']);
    const offsite = events.find((e) => e.uid === 'offsite')!;
    expect(offsite.summary).toBe('Offsite, day 1');
    expect(offsite.allDay).toBe(true);
    expect(offsite.description).toBe('Bring laptops\nandbadges');
  });

  it('fetches the feed with the URL from the keychain and indexes events', async () => {
    let fetched = '';
    const calendar = new CalendarConnectorLifecycle(network, async (url) => { fetched = url; return ICS; }, () => Date.parse('2026-10-24T00:00:00Z'));
    const { runtime } = runtimeWith({ calendar });
    const view = await runtime.createCalendar({ name: 'Team', url: 'webcal://calendar.example.com/private-abc123/basic.ics' });
    await runtime.sync(view.id, 'event');
    expect(fetched).toBe('https://calendar.example.com/private-abc123/basic.ics');
    expect(runtime.view(view.id).itemCount).toBe(4);
    expect(JSON.stringify(runtime.view(view.id).config)).not.toContain('private-abc123');
  });

  it('refuses plain http feeds and blocks syncing after consent is revoked', async () => {
    const calendar = new CalendarConnectorLifecycle(network, async () => ICS);
    const { runtime } = runtimeWith({ calendar });
    await expect(runtime.createCalendar({ name: 'x', url: 'http://calendar.example.com/a.ics' })).rejects.toThrow(/https/);
    const view = await runtime.createCalendar({ name: 'Team', url: 'https://calendar.example.com/a.ics' });
    expect((await runtime.sync(view.id, 'event')).succeeded).toBe(true); // joins the initial sync
    consented.clear();
    const outcome = await runtime.sync(view.id, 'event');
    expect(outcome.succeeded).toBe(false);
    expect(outcome.error).toMatch(/No consent/);
  });
});

describe('Slack connector', () => {
  it('reads member conversations since the cursor and names authors', async () => {
    const calls: { method: string; params: Record<string, string>; token: string }[] = [];
    const call: SlackCall = async (method, params, token) => {
      calls.push({ method, params, token });
      if (method === 'users.list') return { ok: true, members: [{ id: 'U1', real_name: 'Ada' }] };
      if (method === 'conversations.list') return { ok: true, channels: [{ id: 'C1', name: 'eng', is_member: true }, { id: 'C2', name: 'random', is_member: false }] };
      if (method === 'conversations.history') return { ok: true, messages: params['oldest'] === '1761300000.000200' ? [] : [{ ts: '1761300000.000100', user: 'U1', text: 'Deploy is at 5pm?' }, { ts: '1761300000.000200', user: 'U1', text: 'ok' }, { ts: '1761300000.000300', subtype: 'channel_join', text: 'joined' }] };
      return { ok: true };
    };
    const slack = new SlackConnectorLifecycle(network, call, () => Date.parse('2026-10-24T00:00:00Z'));
    const { runtime } = runtimeWith({ messaging: slack });
    const view = await runtime.createSlack({ name: 'Acme', token: 'xoxp-1-abc' });
    await runtime.sync(view.id, 'event');
    expect(calls.every((c) => c.token === 'xoxp-1-abc')).toBe(true);
    expect(calls.filter((c) => c.method === 'conversations.history').map((c) => c.params['channel'])).toEqual(['C1', 'C1']);
    expect(runtime.items(view.id).map((i) => i.origin)).toEqual(['Slack · #eng', 'Slack · #eng']);
    await expect(runtime.createSlack({ name: 'bad', token: 'not-a-token' })).rejects.toThrow(/xoxp/);
  });
});

function task(id: string, state: Task['state'], minutes: number): Task {
  const createdAt = '2026-10-24T00:00:00.000Z';
  return { id, workspaceId: 'w', objective: 'do it', acceptanceCriteria: ['response: nonempty'], contextRefs: [], state, createdAt, updatedAt: new Date(Date.parse(createdAt) + minutes * 60_000).toISOString() };
}

describe('learning loop', () => {
  it('records outcomes, proposes a demonstrated routing improvement, applies it on approval and rolls back on regression', () => {
    const workspace = new WorkspaceService(store).create({ name: 'W', rootPath: dir });
    const engine = new SelfLearningEngine(store, audit);
    const loop = new LearningLoop(store, engine);
    let n = 0;
    const finish = (adapter: string, state: Task['state'], minutes: number) => {
      const t = { ...task(`00000000-0000-4000-8000-${String(n += 1).padStart(12, '0')}`, state, minutes), workspaceId: workspace.id };
      store.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, acceptance_criteria, state, context_refs, created_at, updated_at) VALUES (?, ?, 'x', '[]', ?, '[]', ?, ?)`).run(t.id, t.workspaceId, t.state, t.createdAt, t.updatedAt);
      store.db.prepare(`INSERT INTO task_steps (id, task_id, ordinal, description, depends_on, assigned_adapter_id, status) VALUES (?, ?, 0, 's', '[]', ?, ?)`).run(`${t.id}-s`, t.id, adapter, state === 'COMPLETED' ? 'succeeded' : 'failed');
      return loop.onTaskFinished(t);
    };
    for (let i = 0; i < 3; i += 1) finish('claude-code', 'FAILED', 10);
    for (let i = 0; i < 2; i += 1) finish('codex', 'COMPLETED', 5);
    const result = finish('codex', 'COMPLETED', 5);
    expect(result.outcome?.toolUsage).toEqual(['codex']);
    const proposal = result.proposal!;
    expect(proposal.kind).toBe('routing_rule');
    expect(proposal.payload).toEqual({ capability: 'objective.fulfill', preferAdapterId: 'codex' });
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(0.5); // not applied before approval

    engine.approve(proposal.id);
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(1);
    expect(loop.routingScore('claude-code', 'objective.fulfill')).toBe(0.5);

    for (let i = 0; i < 3; i += 1) finish('codex', 'FAILED', 30);
    expect(engine.getProposal(proposal.id)!.status).toBe('rolled_back');
    expect(loop.routingScore('codex', 'objective.fulfill')).toBe(0.5);
  });
});

describe('proactive suggestions', () => {
  it('suggests retrying stuck tasks and drafting replies to questions, deduplicated, executed only on confirmation', async () => {
    const permissions = new PermissionService(store, audit);
    const emitter = new RecordingSuggestionEmitter();
    const created: { workspaceId: string; objective: string }[] = [];
    const retried: string[] = [];
    const assistant = new ProactiveAssistant(store, audit, permissions, connectorSources(store), emitter, suggestionExecutor({
      retryTask: async (id) => { retried.push(id); }, resumeTask: async () => undefined, createTask: async (input) => { created.push(input); },
    }));
    const signals = new ProactiveSignals(store, assistant, () => 'w-active', () => Date.parse('2026-10-24T00:00:00Z'));

    const stuck = { ...task('t-1', 'BLOCKED', 1), recommendedNextAction: 'Sign in to Codex' };
    await signals.onTaskStuck(stuck);
    await signals.onTaskStuck(stuck);
    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]!.status).toBe('suggested');
    expect(retried).toEqual([]);
    await assistant.confirm(emitter.emitted[0]!.id);
    expect(retried).toEqual(['t-1']);

    const email = new EmailConnectorLifecycle(network, () => fakeMail({ ranges: [] }, [1]));
    const { runtime } = runtimeWith({ email }, (c, o) => { void signals.onConnectorSynced(c, o); });
    const view = await runtime.createEmail({ name: 'Work', host: 'imap.example.com', port: 993, secure: true, user: 'me@example.com', password: 'p' });
    await runtime.sync(view.id, 'event');
    await new Promise((r) => setTimeout(r, 20));
    const reply = emitter.emitted.find((s) => s.trigger.kind === 'email_awaiting_reply')!;
    expect(reply.action.kind).toBe('create_task');
    expect((reply.action.payload as { objective: string }).objective).toContain('Do not send anything');
    expect(created).toEqual([]);
    await assistant.confirm(reply.id);
    expect(created[0]!.workspaceId).toBe('w-active');
  });
});
