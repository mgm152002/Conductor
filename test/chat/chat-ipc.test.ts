import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '@main/db/store';
import { ChatService } from '@main/domain/chat-service';
import { Registry } from '@main/registry/registry';
import { IpcRouter } from '@main/ipc/router';
import { IpcChatEventEmitter, registerChatHandlers } from '@main/ipc/register-chat';
import { FakeAdapter } from '../fakes/fake-adapter';
import type { ChatConversation } from '@shared/chat-contract';
import type { IpcResult } from '@shared/ipc-contract';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.resetModules(); vi.doUnmock('electron'); });

describe('chat IPC boundary', () => {
  it('validates requests, returns the scheduled conversation, and publishes persisted snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chat-ipc-'));
    const store = new SqliteStore(':memory:');
    cleanup = () => { store.close(); rmSync(root, { recursive: true, force: true }); };
    await store.migrate();
    const registry = new Registry();
    registry.register(new FakeAdapter({ record: { class: 'local_cli_agent', capabilities: [{ id: 'objective.fulfill', title: 'chat', inputSchema: {}, outputSchema: {}, streaming: true, cancellable: true, resumable: false, requiredPermissions: [] }] }, script: { events: [{ kind: 'stdout', data: 'answer' }] } }));
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>>();
    const router = new IpcRouter({ ipcMain: { handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>) => { handlers.set(name, handler); } } as unknown as IpcMain });
    const events: { channel: string; payload: ChatConversation }[] = [];
    const emitter = new IpcChatEventEmitter(router);
    emitter.setWebContentsResolver(() => ({ isDestroyed: () => false, send: (channel: string, payload: ChatConversation) => events.push({ channel, payload }) }) as unknown as WebContents);
    const chat = new ChatService(store, registry, join(root, 'chat-sandbox'), (snapshot) => emitter.emit(snapshot));
    registerChatHandlers(router, chat);
    const invoke = (name: string, input?: unknown) => handlers.get(name)!({} as IpcMainInvokeEvent, input);
    expect(await invoke('chat.send', { content: ' ', workspaceId: 'forbidden' })).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(await invoke('chat.list')).toEqual({ ok: true, value: [] });
    const sent = await invoke('chat.send', { content: 'hi' }) as IpcResult<ChatConversation>;
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error('send failed');
    expect(sent.value.messages.at(-1)?.status).toBe('streaming');
    await expect.poll(() => events.at(-1)?.payload.messages.at(-1)?.status).toBe('complete');
    expect(await invoke('chat.get', { threadId: sent.value.thread.id })).toEqual({ ok: true, value: events.at(-1)?.payload });
    expect(events.every((e) => e.channel === 'chat.updated')).toBe(true);
    const renamed = await invoke('chat.rename', { threadId: sent.value.thread.id, title: '  Renamed chat  ' }) as IpcResult<{ title: string }>;
    expect(renamed).toEqual({ ok: true, value: expect.objectContaining({ title: 'Renamed chat' }) });
    expect(chat.list()).toEqual([expect.objectContaining({ title: 'Renamed chat' })]);
    expect(chat.get(sent.value.thread.id).messages[0]?.content).toBe('hi');
    expect(await invoke('chat.rename', { threadId: sent.value.thread.id, title: ' ' })).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(await invoke('chat.rename', { threadId: '00000000-0000-4000-8000-000000000000', title: 'Nope' })).toMatchObject({ ok: false, error: { code: 'handler_error', message: expect.stringMatching(/not found/i) } });
    expect(await invoke('chat.cancel', { threadId: sent.value.thread.id })).toEqual({ ok: true, value: undefined });
    expect(await invoke('chat.delete', { threadId: sent.value.thread.id })).toEqual({ ok: true, value: undefined });
    expect(await invoke('chat.list')).toEqual({ ok: true, value: [] });
    expect(await invoke('chat.get', { threadId: sent.value.thread.id })).toMatchObject({ ok: false, error: { code: 'handler_error', message: expect.stringMatching(/not found/i) } });
    expect(await invoke('chat.delete', { threadId: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ ok: false, error: { code: 'handler_error', message: expect.stringMatching(/not found/i) } });
    expect(await invoke('chat.delete', { threadId: 'bad' })).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(await invoke('chat.get', { threadId: 'bad' })).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });

  it('exposes typed chat calls through preload and unsubscribes chat.updated safely', async () => {
    let exposed: unknown;
    const invokes: unknown[][] = [];
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
      ipcRenderer: {
        invoke: async (...args: unknown[]) => { invokes.push(args); return { ok: true, value: [] }; },
        on: (name: string, handler: (event: unknown, payload: unknown) => void) => listeners.set(name, handler),
        removeListener: (name: string) => listeners.delete(name),
      },
    }));
    await import('../../src/preload/index');
    const bridge = exposed as import('../../src/preload/index').ConductorBridge;
    await bridge.chat.list();
    await bridge.chat.get('thread');
    await bridge.chat.send({ content: 'hello', agentId: 'codex' });
    await bridge.chat.cancel('thread');
    await bridge.chat.delete('thread');
    await bridge.chat.rename('thread', 'Renamed');
    expect(invokes).toEqual([
      ['chat.list', undefined], ['chat.get', { threadId: 'thread' }],
      ['chat.send', { content: 'hello', agentId: 'codex' }], ['chat.cancel', { threadId: 'thread' }],
      ['chat.delete', { threadId: 'thread' }], ['chat.rename', { threadId: 'thread', title: 'Renamed' }],
    ]);
    let snapshot: unknown;
    const off = bridge.on('chat.updated', (value) => { snapshot = value; });
    listeners.get('chat.updated')!({ privileged: 'electron event' }, { thread: { id: 'thread' }, messages: [] });
    expect(snapshot).toEqual({ thread: { id: 'thread' }, messages: [] });
    off();
    expect(listeners.has('chat.updated')).toBe(false);
  });
});
