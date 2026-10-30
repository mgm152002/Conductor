import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '@main/db/store';
import { Registry } from '@main/registry/registry';
import { ChatService } from '@main/domain/chat-service';
import { SettingsService } from '@main/domain/settings-service';
import { WorkspaceService } from '@main/domain/workspace-service';
import { defaultModelKey, fallbackModelKey } from '@shared/model-defaults';
import { FakeAdapter } from '../fakes/fake-adapter';
import type { AdapterSessionHandle } from '@shared/adapter';
import type { ChatConversation } from '@shared/chat-contract';
import { AttachmentService } from '@main/attachments/attachment-service';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { MemoryEngine } from '@main/domain/memory-engine';
import { mockMem0 } from '../helpers/mem0';
import type { ObjectiveInput } from '@main/adapters/objective-cli-adapter';

const roots: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(script: ConstructorParameters<typeof FakeAdapter>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'conductor-chat-'));
  roots.push(root);
  const path = join(root, 'chat.db');
  const store = new SqliteStore(path);
  stores.push(store);
  await store.migrate();
  const registry = new Registry();
  const adapter = new FakeAdapter({ ...script, record: {
    id: 'chat-agent', class: 'local_cli_agent', available: true,
    capabilities: [{ id: 'objective.fulfill', title: 'Chat', inputSchema: {}, outputSchema: {}, streaming: true, cancellable: true, resumable: false, requiredPermissions: [] }],
    ...script.record,
  } });
  registry.register(adapter);
  const updates: ChatConversation[] = [];
  const storage = new DiskManagedStorage(join(root, 'blobs'));
  const attachments = new AttachmentService(store, storage);
  const service = new ChatService(store, registry, join(root, 'chat-sandbox'), (snapshot) => updates.push(snapshot), { attachments });
  return { root, path, store, registry, adapter, updates, storage, attachments, service };
}

async function settled(service: ChatService, id: string) {
  await expect.poll(() => service.get(id).messages.at(-1)?.status).not.toBe('streaming');
  return service.get(id);
}

describe('standalone casual chat', () => {
  it('switches CLI mid-thread and hands the new agent the conversation history', async () => {
    const { service, registry, adapter } = await setup({ script: { events: [{ kind: 'stdout', data: 'first reply' }] } });
    const second = new FakeAdapter({ script: { events: [{ kind: 'stdout', data: 'second reply' }] }, record: {
      id: 'other-agent', class: 'local_cli_agent', available: true,
      capabilities: [{ id: 'objective.fulfill', title: 'Chat', inputSchema: {}, outputSchema: {}, streaming: true, cancellable: true, resumable: false, requiredPermissions: [] }],
    } });
    registry.register(second);

    const first = await service.send({ content: 'Hello', agentId: 'chat-agent' });
    await settled(service, first.thread.id);

    const next = await service.send({ threadId: first.thread.id, content: 'Continue', agentId: 'other-agent' });
    const done = await settled(service, next.thread.id);
    expect(done.thread.agentId).toBe('other-agent');
    expect(done.messages.at(-1)?.content).toBe('second reply');
    expect(adapter.calls.started).toHaveLength(1);
    expect(second.calls.started).toHaveLength(1);
    const input = second.calls.started[0] as ObjectiveInput;
    expect(input.conversation).toEqual([{ objective: 'Hello', reply: 'first reply', state: 'complete' }]);
  });

  it('replaces the first-message placeholder title with the generated title', async () => {
    const { root, store, registry } = await setup({ script: { events: [{ kind: 'stdout', data: 'reply' }] } });
    const updates: ChatConversation[] = [];
    const service = new ChatService(store, registry, join(root, 'chat-sandbox'), (snapshot) => updates.push(snapshot), {
      generateTitle: async () => 'Weekend plan ideas',
    });
    const sent = await service.send({ content: 'help me plan a weekend trip to the coast with good food' });
    expect(sent.thread.title).toBe('help me plan a weekend trip to the coast with good food');
    await expect.poll(() => service.get(sent.thread.id).thread.title).toBe('Weekend plan ideas');
    expect(updates.some((u) => u.thread.title === 'Weekend plan ideas')).toBe(true);
    await settled(service, sent.thread.id);
    // Follow-ups never retitle the thread.
    const next = await service.send({ threadId: sent.thread.id, content: 'make it cheaper' });
    await settled(service, next.thread.id);
    expect(service.get(sent.thread.id).thread.title).toBe('Weekend plan ideas');
  });

  it('records the CLI and model on each reply and shows a handoff when the user switches', async () => {
    const { service, registry } = await setup({ script: { events: [{ kind: 'stdout', data: 'first reply' }] } });
    const second = new FakeAdapter({ script: { events: [{ kind: 'stdout', data: 'second reply' }] }, record: {
      id: 'other-agent', class: 'local_cli_agent', available: true,
      capabilities: [{ id: 'objective.fulfill', title: 'Chat', inputSchema: {}, outputSchema: {}, streaming: true, cancellable: true, resumable: false, requiredPermissions: [] }],
    } });
    registry.register(second);

    const first = await service.send({ content: 'Hello', agentId: 'chat-agent', runOptions: { model: 'model-a' } });
    const doneFirst = await settled(service, first.thread.id);
    expect(doneFirst.messages.at(-1)).toMatchObject({ agentId: 'chat-agent', model: 'model-a' });

    const next = await service.send({ threadId: first.thread.id, content: 'Continue', agentId: 'other-agent', runOptions: { model: 'model-b' } });
    const done = await settled(service, next.thread.id);
    expect(done.messages.at(-1)).toMatchObject({ agentId: 'other-agent', model: 'model-b', content: 'second reply' });
    // The between-reply divider is derived from these agent/model fields, so
    // no inline handoff is stored as well (that showed the switch twice).
    expect(done.messages.at(-1)?.activity?.some((entry) => entry.kind === 'handoff')).toBe(false);
  });

  it('records a handoff activity when a fallback agent takes over mid-reply', async () => {
    const { service, registry } = await setup({ script: { result: { status: 'failed', error: 'quota exhausted for this account' } } });
    const second = new FakeAdapter({ script: { events: [{ kind: 'stdout', data: 'recovered reply' }] }, record: {
      id: 'other-agent', class: 'local_cli_agent', available: true,
      capabilities: [{ id: 'objective.fulfill', title: 'Chat', inputSchema: {}, outputSchema: {}, streaming: true, cancellable: true, resumable: false, requiredPermissions: [] }],
    } });
    registry.register(second);

    const sent = await service.send({ content: 'Hello' });
    const done = await settled(service, sent.thread.id);
    const reply = done.messages.at(-1)!;
    expect(reply.content).toBe('recovered reply');
    expect(reply.agentId).toBe('other-agent');
    const handoff = reply.activity?.find((entry) => entry.kind === 'handoff');
    expect(handoff?.handoff).toMatchObject({ fromAgentId: 'chat-agent', toAgentId: 'other-agent' });
    expect(handoff?.handoff?.reason).toContain('quota');
  });

  it('backfills titles for chats still carrying the first-message placeholder', async () => {
    const { root, store, registry } = await setup({ script: { events: [{ kind: 'stdout', data: 'reply' }] } });
    const service = new ChatService(store, registry, join(root, 'chat-sandbox'), () => {}, {
      generateTitle: async (first) => (first.startsWith('help me') ? 'Weekend plan ideas' : 'Generated title'),
    });
    const sent = await service.send({ content: 'help me plan a weekend trip to the coast' });
    await settled(service, sent.thread.id);
    // Simulate a chat created before auto-titles: reset to the placeholder.
    store.db.prepare('UPDATE chat_threads SET title=? WHERE id=?')
      .run('help me plan a weekend trip to the coast', sent.thread.id);
    const renamed = await service.send({ content: 'a renamed chat first message' });
    await settled(service, renamed.thread.id);
    store.db.prepare('UPDATE chat_threads SET title=? WHERE id=?').run('My own name', renamed.thread.id);

    await service.backfillTitles(10);
    expect(service.get(sent.thread.id).thread.title).toBe('Weekend plan ideas');
    // A user-chosen title is never treated as a placeholder.
    expect(service.get(renamed.thread.id).thread.title).toBe('My own name');
  });

  it('persists attachments, materializes only the current turn, and omits prior attachment metadata from agent history', async () => {
    const { service, attachments, adapter, updates, root, path } = await setup({ script: {
      events: [{ kind: 'stdout', data: 'first answer' }],
      streamDelayMs: 20,
    } });
    const source = join(root, 'notes.md');
    writeFileSync(source, '# Meeting notes\n\nTreat this as reference data.');
    const ingested = await attachments.ingest([source]);
    const attachment = ingested.attachments[0]!;

    const first = await service.send({ content: 'Summarize this', attachments: [attachment.id] });
    expect(first.messages[0]?.attachments).toEqual([expect.objectContaining({ id: attachment.id, name: 'notes.md' })]);
    expect(first.messages[1]?.attachments).toEqual([]);
    expect(updates.at(-1)?.messages[0]?.attachments).toEqual([expect.objectContaining({ id: attachment.id })]);
    await settled(service, first.thread.id);

    const firstInput = adapter.calls.started[0] as ObjectiveInput;
    expect(firstInput.attachments).toHaveLength(1);
    expect(firstInput.attachments?.[0]).toMatchObject({
      id: attachment.id,
      extractedText: '# Meeting notes\n\nTreat this as reference data.',
    });
    expect(firstInput.description).toContain('inspect the exact current-turn attachment paths');
    expect(firstInput.description).toContain('Use your read-only file-reading capability');
    expect(firstInput.description).not.toContain('Do not use tools, execute commands, read or change files');
    expect(isAbsolute(firstInput.attachments?.[0]?.path ?? '')).toBe(true);
    expect(existsSync(firstInput.attachments?.[0]?.path ?? '')).toBe(true);

    const second = await service.send({ threadId: first.thread.id, content: 'What was attached?' });
    await settled(service, second.thread.id);
    const secondInput = adapter.calls.started[1] as ObjectiveInput;
    expect(secondInput).not.toHaveProperty('attachments');
    expect(secondInput.conversation).toEqual([]);

    const reopened = new SqliteStore(path);
    stores.push(reopened);
    await reopened.migrate();
    const reloaded = new ChatService(
      reopened,
      new Registry(),
      join(root, 'chat-sandbox'),
      () => {},
      { attachments: new AttachmentService(reopened, new DiskManagedStorage(join(root, 'blobs'))) },
    ).get(first.thread.id);
    expect(reloaded.messages[0]?.attachments).toEqual([expect.objectContaining({ id: attachment.id })]);
  });

  it('recalls only global personal memory in casual chat', async () => {
    const { store, registry, root, adapter, attachments } = await setup({ script: { events: [{ kind: 'stdout', data: 'answer' }] } });
    const memory = new MemoryEngine(store, Date.now, mockMem0().client);
    await memory.create({ layer: 'personal', scope: { level: 'global' }, content: 'pineapple preference' });
    await memory.create({ layer: 'project', scope: { level: 'project', refId: 'project-a' }, content: 'pineapple project secret' });
    await memory.create({ layer: 'project', scope: { level: 'project', refId: 'project-b' }, content: 'pineapple other secret' });
    const isolated = new ChatService(store, registry, join(root, 'isolated-chat-sandbox'), () => {}, { attachments, memory });

    const sent = await isolated.send({ content: 'What is my pineapple preference?' });
    await settled(isolated, sent.thread.id);

    expect((adapter.calls.started[0] as ObjectiveInput).contextData).toEqual([
      { kind: 'memory', content: 'pineapple preference' },
    ]);
  });

  it('groups chats into spaces and shares context only within a space', async () => {
    const { service, adapter } = await setup({ script: { events: [{ kind: 'stdout', data: 'reply' }] } });
    const space = service.createSpace('  Trip planning  ');
    expect(space).toMatchObject({ name: 'Trip planning', threadCount: 0 });
    expect(() => service.createSpace('   ')).toThrow(/cannot be empty/);
    expect(() => service.renameSpace(randomUUID(), 'Nope')).toThrow(/not found/);

    const first = await service.send({ content: 'We are going to Lisbon in May', spaceId: space.id });
    await settled(service, first.thread.id);
    expect(first.thread.spaceId).toBe(space.id);
    expect(service.listSpaces()).toEqual([expect.objectContaining({ id: space.id, threadCount: 1 })]);

    // A second chat in the same space receives the first chat's turns as context.
    const second = await service.send({ content: 'Which city did we pick?', spaceId: space.id });
    await settled(service, second.thread.id);
    const shared = (adapter.calls.started[1] as ObjectiveInput).contextData as { kind: string; content: string }[];
    expect(shared).toEqual([expect.objectContaining({ kind: 'space', spaceId: space.id })]);
    expect(shared[0]?.content).toContain('Lisbon in May');
    expect(shared[0]?.content).toContain('reply');

    // An ungrouped chat never receives space context.
    const solo = await service.send({ content: 'Which city did we pick?' });
    await settled(service, solo.thread.id);
    expect(solo.thread.spaceId).toBeNull();
    expect((adapter.calls.started[2] as ObjectiveInput).contextData ?? []).toEqual([]);

    // Moving the ungrouped chat into the space opts it into the shared context.
    expect(service.setThreadSpace(solo.thread.id, space.id).spaceId).toBe(space.id);
    expect(() => service.setThreadSpace(solo.thread.id, randomUUID())).toThrow(/not found/);
    const followUp = await service.send({ threadId: solo.thread.id, content: 'And which city was it?' });
    await settled(service, followUp.thread.id);
    const moved = (adapter.calls.started[3] as ObjectiveInput).contextData as { kind: string; content: string }[];
    expect(moved.some((entry) => entry.kind === 'space' && entry.content.includes('Lisbon'))).toBe(true);

    // A chat in a different space does not see this space's turns.
    const other = service.createSpace('Other');
    const outsider = await service.send({ content: 'Which city?', spaceId: other.id });
    await settled(service, outsider.thread.id);
    expect((adapter.calls.started[4] as ObjectiveInput).contextData ?? []).toEqual([]);

    // Deleting a space keeps its chats, ungrouped.
    service.deleteSpace(space.id);
    expect(service.listSpaces().map((s) => s.id)).toEqual([other.id]);
    expect(service.get(first.thread.id).thread.spaceId).toBeNull();
    expect(service.list()).toHaveLength(4);
  });

  it('stops sharing context in both directions when a chat is moved out of a space', async () => {
    const { service, adapter } = await setup({ script: { events: [{ kind: 'stdout', data: 'reply' }] } });
    const space = service.createSpace('Trip');

    const first = await service.send({ content: 'We are going to Lisbon in May', spaceId: space.id });
    await settled(service, first.thread.id);
    const second = await service.send({ content: 'The hotel budget is 200 a night', spaceId: space.id });
    await settled(service, second.thread.id);
    expect(service.listSpaces()).toEqual([expect.objectContaining({ id: space.id, threadCount: 2 })]);

    // Removing the second chat ungroups it and shrinks the space.
    expect(service.setThreadSpace(second.thread.id, null).spaceId).toBeNull();
    expect(service.listSpaces()).toEqual([expect.objectContaining({ id: space.id, threadCount: 1 })]);

    // The removed chat no longer receives the space's context.
    const removedFollowUp = await service.send({ threadId: second.thread.id, content: 'Which city did we pick?' });
    await settled(service, removedFollowUp.thread.id);
    const removedContext = (adapter.calls.started[2] as ObjectiveInput).contextData ?? [];
    expect(removedContext).toEqual([]);
    expect(JSON.stringify(removedContext)).not.toContain('Lisbon');

    // And the chats left in the space no longer receive the removed chat's turns.
    const remainingFollowUp = await service.send({ threadId: first.thread.id, content: 'What was the hotel budget?' });
    await settled(service, remainingFollowUp.thread.id);
    const remainingContext = (adapter.calls.started[3] as ObjectiveInput).contextData ?? [];
    expect(remainingContext).toEqual([]);
    expect(JSON.stringify(remainingContext)).not.toContain('hotel budget');
  });

  it('passes locally recognized pasted-image text only with the current turn attachment', async () => {
    const { store, registry, root, adapter } = await setup({ script: { events: [{ kind: 'stdout', data: 'answer' }] } });
    const image = {
      id: '00000000-0000-4000-8000-000000000001', name: 'pasted-image.png', kind: 'image' as const, mimeType: 'image/png',
      sizeBytes: 24, sha256: 'a'.repeat(64), createdAt: '2026-10-26T00:00:00Z',
    };
    const delivery = {
      validate: vi.fn(() => [image]),
      linkChat: vi.fn(() => [image]),
      listChat: vi.fn(() => [image]),
      materialize: vi.fn(async () => [{
        ...image, path: '/private/tmp/current-turn-pasted-image.png',
        extractedText: 'Revenue grew 18 percent year over year.',
      }]),
    } as unknown as AttachmentService;
    const ocrChat = new ChatService(store, registry, join(root, 'ocr-chat-sandbox'), () => {}, { attachments: delivery });

    const sent = await ocrChat.send({ content: 'What does this image say?', attachments: [image.id] });
    await settled(ocrChat, sent.thread.id);

    const input = adapter.calls.started[0] as ObjectiveInput;
    expect(input.attachments).toEqual([expect.objectContaining({
      id: image.id,
      extractedText: 'Revenue grew 18 percent year over year.',
    })]);
    expect(delivery.materialize).toHaveBeenCalledOnce();
    const followUp = await ocrChat.send({ threadId: sent.thread.id, content: 'And now?' });
    await settled(ocrChat, followUp.thread.id);
    expect((adapter.calls.started[1] as ObjectiveInput)).not.toHaveProperty('attachments');
  });

  it('removes chat attachment links, materialized copies, and unreferenced blobs on deletion', async () => {
    const { service, attachments, storage, store, root } = await setup({ script: { events: [{ kind: 'stdout', data: 'answer' }] } });
    const source = join(root, 'delete-me.txt');
    writeFileSync(source, 'temporary attachment');
    const attachment = (await attachments.ingest([source])).attachments[0]!;
    const blob = store.db.prepare('SELECT blob_id FROM attachments WHERE id=?').get(attachment.id) as { blob_id: string };
    const sent = await service.send({ content: 'Use this', attachments: [attachment.id] });
    await settled(service, sent.thread.id);
    const materialized = (store.db.prepare(`SELECT cma.materialized_path
      FROM chat_message_attachments cma
      JOIN chat_messages cm ON cm.id=cma.message_id
      WHERE cm.thread_id=?`).get(sent.thread.id) as { materialized_path: string }).materialized_path;
    expect(existsSync(materialized)).toBe(true);

    await service.delete(sent.thread.id);

    expect(existsSync(materialized)).toBe(false);
    expect(storage.has(blob.blob_id)).toBe(false);
    expect(store.db.prepare('SELECT count(*) AS n FROM chat_message_attachments').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT count(*) AS n FROM attachments WHERE id=?').get(attachment.id)).toEqual({ n: 0 });
  });

  it('returns a scheduled snapshot promptly, persists streaming and final replies without creating Work data', async () => {
    const { service, store, adapter, updates, path, root } = await setup({ script: {
      events: [{ kind: 'stdout', data: 'Hello' }, { kind: 'stderr', data: 'private diagnostic' }, { kind: 'stdout', data: 'there' }],
      streamDelayMs: 30,
    } });
    const pending = await service.send({ content: 'Hello world' });
    expect(pending.messages.map((m) => [m.role, m.status])).toEqual([['user', 'complete'], ['assistant', 'streaming']]);
    const done = await settled(service, pending.thread.id);
    expect(done.messages.at(-1)?.content).toBe('Hello\nthere');
    expect(updates.some((s) => s.messages.at(-1)?.content === 'Hello' && s.messages.at(-1)?.status === 'streaming')).toBe(true);
    expect(service.list()).toEqual([done.thread]);
    expect(adapter.calls.started[0]).toMatchObject({ objective: 'Hello world', rootPath: join(root, 'chat-sandbox'), mode: 'read_only', conversationOnly: true });
    expect(adapter.calls.started[0]).not.toHaveProperty('mcpServers');
    expect(adapter.calls.started[0]).not.toHaveProperty('workspaceId');
    expect(statSync(join(root, 'chat-sandbox')).mode & 0o777).toBe(0o700);
    for (const table of ['workspaces', 'tasks', 'agent_sessions', 'context_items', 'memories']) {
      expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    const reopened = new SqliteStore(path);
    stores.push(reopened);
    await reopened.migrate();
    expect(new ChatService(reopened, new Registry(), join(root, 'chat-sandbox')).get(done.thread.id)).toEqual(done);
  });

  it('persists reasoning and keyed tool activity with the assistant reply', async () => {
    const { service, path, root } = await setup({ script: {
      events: [
        { kind: 'log', data: { message: 'Inspecting the request.', kind: 'reasoning', source: 'Chat Agent' } },
        { kind: 'log', data: { message: 'Read', kind: 'read', detail: '/tmp/notes.md', key: 'tool-1', status: 'running', source: 'Chat Agent' } },
        { kind: 'log', data: { key: 'tool-1', status: 'completed', source: 'Chat Agent' } },
        { kind: 'stdout', data: 'Here is the answer.' },
      ],
    } });

    const sent = await service.send({ content: 'Read my notes' });
    const done = await settled(service, sent.thread.id);
    expect(done.messages.at(-1)?.activity).toEqual([
      expect.objectContaining({ label: 'Inspecting the request.', kind: 'reasoning', source: 'Chat Agent', status: 'neutral' }),
      expect.objectContaining({ label: 'Read', kind: 'read', detail: '/tmp/notes.md', key: 'tool-1', source: 'Chat Agent', status: 'completed' }),
    ]);

    const reopened = new SqliteStore(path);
    stores.push(reopened);
    await reopened.migrate();
    const reloaded = new ChatService(reopened, new Registry(), join(root, 'chat-sandbox')).get(done.thread.id);
    expect(reloaded.messages.at(-1)?.activity).toEqual(done.messages.at(-1)?.activity);
  });

  it('passes only this chat history, supports agent switching, and rejects overlapping sends', async () => {
    const { service, adapter, registry } = await setup({ script: { events: [{ kind: 'stdout', data: 'first answer' }], streamDelayMs: 20 } });
    const first = await service.send({ content: 'remember apricots' });
    await expect(service.send({ threadId: first.thread.id, content: 'too soon' })).rejects.toThrow(/already|running/i);
    await settled(service, first.thread.id);
    const other = await service.send({ content: 'unrelated secret' });
    await settled(service, other.thread.id);
    const second = new FakeAdapter({ record: { ...adapter.record, id: 'other-agent' }, script: { result: { status: 'succeeded', output: 'follow-up answer' } } });
    registry.register(second);
    const sent = await service.send({ threadId: first.thread.id, content: 'what fruit?', agentId: 'other-agent' });
    const done = await settled(service, sent.thread.id);
    expect(second.calls.started[0]).toMatchObject({ conversation: [{ objective: 'remember apricots', reply: 'first answer', state: 'complete' }] });
    expect(JSON.stringify(second.calls.started[0])).not.toContain('unrelated secret');
    expect(done.thread.agentId).toBe('other-agent');
    expect(done.messages.at(-1)?.content).toBe('follow-up answer');
  });

  it('records start/stream/result failures and preserves partial output', async () => {
    const { service } = await setup({ script: { crashAt: 'start', crashMessage: 'consent denied' } });
    const first = await service.send({ content: 'hi' });
    expect((await settled(service, first.thread.id)).messages.at(-1)).toMatchObject({ status: 'failed', error: 'consent denied' });
    const { service: failed } = await setup({ script: { events: [{ kind: 'stdout', data: 'partial' }], result: { status: 'failed', error: 'offline' } } });
    const pending = await failed.send({ content: 'hi' });
    expect((await settled(failed, pending.thread.id)).messages.at(-1)).toMatchObject({ content: 'partial', status: 'failed', error: 'offline' });
    const { service: crashed } = await setup({ script: { crashAt: 'stream', crashMessage: 'stream broke' } });
    const streaming = await crashed.send({ content: 'hi' });
    expect((await settled(crashed, streaming.thread.id)).messages.at(-1)).toMatchObject({ status: 'failed', error: 'stream broke' });
  });

  it('cancels before a delayed start resolves, refuses overlap until cancelled, and ignores late output', async () => {
    const { service, adapter } = await setup({ script: { events: [{ kind: 'stdout', data: 'late' }] } });
    const start = adapter.start.bind(adapter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapter.start = async (input) => { await gate; return start(input); };
    const pending = await service.send({ content: 'hello' });
    // Let the scheduled run enter start(), then cancel while its handle is unavailable.
    await new Promise((r) => setImmediate(r));
    const cancelled = service.cancel(pending.thread.id);
    expect(service.get(pending.thread.id).messages.at(-1)?.status).toBe('cancelled');
    await expect(service.send({ threadId: pending.thread.id, content: 'overlap' })).rejects.toThrow(/already|running/i);
    release();
    await cancelled;
    expect(adapter.calls.cancelled).toHaveLength(1);
    expect(service.get(pending.thread.id).messages.at(-1)).toMatchObject({ content: '', status: 'cancelled' });
    const next = await service.send({ threadId: pending.thread.id, content: 'try again' });
    await settled(service, next.thread.id);
  });

  it('keeps a thread locked when adapter cancellation fails', async () => {
    const { service, adapter } = await setup({ script: { events: [{ kind: 'stdout', data: 'late' }], streamDelayMs: 80 } });
    adapter.cancel = async (_handle: AdapterSessionHandle) => { throw new Error('cancel failed'); };
    const sent = await service.send({ content: 'hello' });
    await new Promise((r) => setImmediate(r));
    await expect(service.cancel(sent.thread.id)).rejects.toThrow('cancel failed');
    await expect(service.send({ threadId: sent.thread.id, content: 'overlap' })).rejects.toThrow(/already|running/i);
    await new Promise((r) => setTimeout(r, 120));
    expect(service.get(sent.thread.id).messages.at(-1)?.status).toBe('cancelled');
    const next = await service.send({ threadId: sent.thread.id, content: 'again' });
    await settled(service, next.thread.id);
  });

  it('deletes an idle thread with all its messages, leaving other threads, work data, and files intact', async () => {
    const { service, store, root } = await setup({ script: { events: [{ kind: 'stdout', data: 'answer' }] } });
    const kept = await service.send({ content: 'keep this conversation' });
    await settled(service, kept.thread.id);
    const doomed = await service.send({ content: 'delete this conversation' });
    await settled(service, doomed.thread.id);
    const marker = join(root, 'chat-sandbox', 'untouched.txt');
    writeFileSync(marker, 'sandbox file');

    await service.delete(doomed.thread.id);

    expect(service.list().map((thread) => thread.id)).toEqual([kept.thread.id]);
    expect(() => service.get(doomed.thread.id)).toThrow(/not found/i);
    expect(store.db.prepare('SELECT count(*) AS n FROM chat_messages WHERE thread_id=?').get(doomed.thread.id)).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT count(*) AS n FROM chat_messages WHERE thread_id=?').get(kept.thread.id)).toEqual({ n: 2 });
    for (const table of ['workspaces', 'tasks', 'agent_sessions', 'context_items', 'memories']) {
      expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(existsSync(marker)).toBe(true);
  });

  it('rejects deleting an unknown chat thread instead of reporting success', async () => {
    const { service } = await setup();
    await expect(service.delete(randomUUID())).rejects.toThrow(/not found/i);
    expect(service.list()).toEqual([]);
  });

  it('rejects deleting a thread while a reply is in flight until the reply is stopped', async () => {
    const { service, adapter } = await setup({ script: { events: [{ kind: 'stdout', data: 'late' }] } });
    const start = adapter.start.bind(adapter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapter.start = async (input) => { await gate; return start(input); };
    const pending = await service.send({ content: 'hello' });
    // Let the scheduled run enter start(), then try to delete while it is blocked.
    await new Promise((r) => setImmediate(r));

    await expect(service.delete(pending.thread.id)).rejects.toThrow(/stop the reply/i);
    expect(service.list()).toEqual([pending.thread]);
    expect(service.get(pending.thread.id).messages).toHaveLength(2);

    release();
    await service.cancel(pending.thread.id);
    await service.delete(pending.thread.id);
    expect(service.list()).toEqual([]);
    expect(() => service.get(pending.thread.id)).toThrow(/not found/i);
  });

  it('recovers interrupted messages on startup, preserving their content', async () => {
    const { store, registry, root, service } = await setup();
    const sent = await service.send({ content: 'hello' });
    await settled(service, sent.thread.id);
    store.db.prepare("UPDATE chat_messages SET status='streaming',content='saved partial' WHERE role='assistant'").run();
    const recovered = new ChatService(store, registry, join(root, 'chat-sandbox'));
    expect(recovered.get(sent.thread.id).messages.at(-1)).toMatchObject({ content: 'saved partial', status: 'failed', error: expect.stringMatching(/interrupt|restart/i) });
  });

  it('clearly rejects no available objective agent and invalid input without creating history', async () => {
    const { service, registry } = await setup();
    registry.deregister('chat-agent');
    await expect(service.send({ content: 'hello' })).rejects.toThrow(/no .*local.*agent/i);
    await expect(service.send({ content: ' ' })).rejects.toThrow();
    await expect(service.send({ content: 'hello', agentId: 'missing' })).rejects.toThrow(/not available/i);
    await expect(service.send({ content: 'hello', threadId: 'missing' })).rejects.toThrow();
    expect(service.list()).toEqual([]);
  });

  it('extracts only Codex assistant JSONL text and handles structured final output', async () => {
    const { service } = await setup({ record: { id: 'codex' }, script: { events: [
      { kind: 'stdout', data: '{"type":"thread.started","thread_id":"provider-thread"}' },
      { kind: 'stdout', data: '{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"ls","aggregated_output":"do not display","exit_code":0,"status":"completed"}}' },
      { kind: 'stdout', data: '{"type":"item.completed","item":{"id":"think-1","type":"reasoning","text":"Checking the available files."}}' },
      { kind: 'stdout', data: '{"type":"item.completed","item":{"type":"agent_message","text":"Actual answer"}}' },
    ] } });
    const sent = await service.send({ content: 'hi' });
    const message = (await settled(service, sent.thread.id)).messages.at(-1);
    expect(message?.content).toBe('Actual answer');
    expect(message?.activity).toEqual([
      expect.objectContaining({ key: 'cmd-1', label: 'ls', kind: 'execute', detail: 'do not display', status: 'completed', source: 'Fake Adapter' }),
      expect.objectContaining({ key: 'think-1', label: 'Checking the available files.', kind: 'reasoning', status: 'neutral', source: 'Fake Adapter' }),
    ]);
  });

  describe('default and fallback model routing', () => {
    it('retries fallback model on quota limit before falling back to second agent with Settings default', async () => {
      const root = mkdtempSync(join(tmpdir(), 'conductor-chat-routing-'));
      roots.push(root);
      const path = join(root, 'chat.db');
      const store = new SqliteStore(path);
      stores.push(store);
      await store.migrate();

      const workspaces = new WorkspaceService(store);
      const settings = new SettingsService(store, workspaces);

      // Configure default and fallback model for first agent, and default model for second agent
      settings.set({ key: defaultModelKey('agent-1'), value: 'agent-1-default', scope: 'global' });
      settings.set({ key: fallbackModelKey('agent-1'), value: 'agent-1-fallback', scope: 'global' });
      settings.set({ key: defaultModelKey('agent-2'), value: 'agent-2-default', scope: 'global' });

      const capability = {
        id: 'objective.fulfill',
        title: 'Chat',
        inputSchema: {},
        outputSchema: {},
        streaming: true,
        cancellable: true,
        resumable: false,
        requiredPermissions: [],
      };

      const firstAdapter = new FakeAdapter({
        record: {
          id: 'agent-1',
          name: 'First Agent',
          class: 'local_cli_agent',
          available: true,
          capabilities: [capability],
        },
        script: {
          events: [],
        },
      });

      // The first agent fails with quota limit on both the primary and fallback attempt
      firstAdapter.await = async () => {
        return { status: 'failed', error: 'usage limit reached: quota exceeded' };
      };

      const secondAdapter = new FakeAdapter({
        record: {
          id: 'agent-2',
          name: 'Second Agent',
          class: 'local_cli_agent',
          available: true,
          capabilities: [capability],
        },
        script: {
          events: [{ kind: 'stdout', data: 'reply from second agent' }],
          result: { status: 'succeeded' },
        },
      });

      const registry = new Registry();
      registry.register(firstAdapter);
      registry.register(secondAdapter);

      const updates: ChatConversation[] = [];
      const service = new ChatService(
        store,
        registry,
        join(root, 'chat-sandbox'),
        (snapshot) => updates.push(snapshot),
        { settings },
      );

      // Send a message with an explicit composer model
      const sent = await service.send({
        content: 'test message',
        runOptions: { model: 'explicit-composer-model' },
      });

      const done = await settled(service, sent.thread.id);

      // 1. Explicit composer model won on the first attempt of the first agent
      expect(firstAdapter.calls.started).toHaveLength(2);
      expect(firstAdapter.calls.started[0]).toMatchObject({
        models: { 'agent-1': 'explicit-composer-model' },
      });

      // 2. The fallback model was tried on the same agent before switching
      expect(firstAdapter.calls.started[1]).toMatchObject({
        models: { 'agent-1': 'agent-1-fallback' },
      });

      // 3. Second agent was tried only after fallback attempt failed, receiving its configured default from Settings
      expect(secondAdapter.calls.started).toHaveLength(1);
      expect(secondAdapter.calls.started[0]).toMatchObject({
        models: { 'agent-2': 'agent-2-default' },
      });
      // And second agent did NOT receive the first attempt's explicit composer model
      expect((secondAdapter.calls.started[0] as { models?: Record<string, string> }).models?.['agent-2']).not.toBe('explicit-composer-model');

      // 4. Completed reply came from second agent
      expect(done.messages.at(-1)?.content).toBe('reply from second agent');
      expect(done.messages.at(-1)?.status).toBe('complete');

      // 5. Streaming intermediate notes reflected fallback retry and handoff
      expect(updates.some((u) => u.messages.at(-1)?.error?.includes('retrying First Agent with fallback model'))).toBe(true);
      expect(updates.some((u) => u.messages.at(-1)?.error?.includes('Second Agent is taking over'))).toBe(true);
    });

    it('recovers with fallback model without switching to second agent when fallback succeeds', async () => {
      const root = mkdtempSync(join(tmpdir(), 'conductor-chat-fallback-success-'));
      roots.push(root);
      const path = join(root, 'chat.db');
      const store = new SqliteStore(path);
      stores.push(store);
      await store.migrate();

      const workspaces = new WorkspaceService(store);
      const settings = new SettingsService(store, workspaces);

      settings.set({ key: defaultModelKey('agent-1'), value: 'agent-1-default', scope: 'global' });
      settings.set({ key: fallbackModelKey('agent-1'), value: 'agent-1-fallback', scope: 'global' });
      settings.set({ key: defaultModelKey('agent-2'), value: 'agent-2-default', scope: 'global' });

      const capability = {
        id: 'objective.fulfill',
        title: 'Chat',
        inputSchema: {},
        outputSchema: {},
        streaming: true,
        cancellable: true,
        resumable: false,
        requiredPermissions: [],
      };

      const firstAdapter = new FakeAdapter({
        record: {
          id: 'agent-1',
          name: 'First Agent',
          class: 'local_cli_agent',
          available: true,
          capabilities: [capability],
        },
      });

      let attemptCount = 0;
      firstAdapter.await = async () => {
        attemptCount += 1;
        if (attemptCount === 1) {
          return { status: 'failed', error: 'rate limit reached: 429 too many requests' };
        }
        return { status: 'succeeded' };
      };
      firstAdapter.stream = async function* () {
        if (attemptCount === 1) {
          yield { kind: 'stdout', data: 'fallback recovered reply', sequence: 1, at: new Date().toISOString() };
        }
      };

      const secondAdapter = new FakeAdapter({
        record: {
          id: 'agent-2',
          name: 'Second Agent',
          class: 'local_cli_agent',
          available: true,
          capabilities: [capability],
        },
      });

      const registry = new Registry();
      registry.register(firstAdapter);
      registry.register(secondAdapter);

      const service = new ChatService(
        store,
        registry,
        join(root, 'chat-sandbox'),
        () => {},
        { settings },
      );

      const sent = await service.send({
        content: 'test fallback recovery',
      });

      const done = await settled(service, sent.thread.id);

      // First attempt used settings default, second attempt used fallback model
      expect(firstAdapter.calls.started).toHaveLength(2);
      expect(firstAdapter.calls.started[0]).toMatchObject({
        models: { 'agent-1': 'agent-1-default' },
      });
      expect(firstAdapter.calls.started[1]).toMatchObject({
        models: { 'agent-1': 'agent-1-fallback' },
      });

      // Second agent was never called
      expect(secondAdapter.calls.started).toHaveLength(0);
      expect(done.thread.agentId).toBe('agent-1');
      expect(done.messages.at(-1)?.content).toBe('fallback recovered reply');
      expect(done.messages.at(-1)?.status).toBe('complete');
    });

    it('switches immediately to second agent with settings default when no fallback model is configured', async () => {
      const root = mkdtempSync(join(tmpdir(), 'conductor-chat-no-fallback-'));
      roots.push(root);
      const path = join(root, 'chat.db');
      const store = new SqliteStore(path);
      stores.push(store);
      await store.migrate();

      const workspaces = new WorkspaceService(store);
      const settings = new SettingsService(store, workspaces);

      // Only default model for agent-1, NO fallback model
      settings.set({ key: defaultModelKey('agent-1'), value: 'agent-1-default', scope: 'global' });
      settings.set({ key: defaultModelKey('agent-2'), value: 'agent-2-default', scope: 'global' });

      const capability = {
        id: 'objective.fulfill',
        title: 'Chat',
        inputSchema: {},
        outputSchema: {},
        streaming: true,
        cancellable: true,
        resumable: false,
        requiredPermissions: [],
      };

      const firstAdapter = new FakeAdapter({
        record: {
          id: 'agent-1',
          name: 'First Agent',
          class: 'local_cli_agent',
          available: true,
          capabilities: [capability],
        },
        script: {
          result: { status: 'failed', error: 'quota exceeded' },
        },
      });

      const secondAdapter = new FakeAdapter({
        record: {
          id: 'agent-2',
          name: 'Second Agent',
          class: 'local_cli_agent',
          available: true,
          capabilities: [capability],
        },
        script: {
          events: [{ kind: 'stdout', data: 'second agent answer' }],
          result: { status: 'succeeded' },
        },
      });

      const registry = new Registry();
      registry.register(firstAdapter);
      registry.register(secondAdapter);

      const service = new ChatService(
        store,
        registry,
        join(root, 'chat-sandbox'),
        () => {},
        { settings },
      );

      const sent = await service.send({
        content: 'test without fallback model',
      });

      const done = await settled(service, sent.thread.id);

      // First agent only tried once (no fallback model configured)
      expect(firstAdapter.calls.started).toHaveLength(1);
      expect(firstAdapter.calls.started[0]).toMatchObject({
        models: { 'agent-1': 'agent-1-default' },
      });

      // Second agent was tried and used its default model from Settings
      expect(secondAdapter.calls.started).toHaveLength(1);
      expect(secondAdapter.calls.started[0]).toMatchObject({
        models: { 'agent-2': 'agent-2-default' },
      });

      expect(done.messages.at(-1)?.content).toBe('second agent answer');
      expect(done.messages.at(-1)?.status).toBe('complete');
    });
  });
});
