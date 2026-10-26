import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { IpcRouter, withValidation } from '@main/ipc/router';
import { MAX_IPC_PAYLOAD_BYTES } from '@shared/ipc-contract';
import type { AuditSink } from '@main/ipc/audit-sink';

const fakeEvent = {} as IpcMainInvokeEvent;

function recordingAudit(): AuditSink & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    append(event) {
      events.push(event);
    },
  };
}

describe('withValidation', () => {
  it('rejects oversized payloads before validation runs', async () => {
    const schema = z.object({ blob: z.string() });
    const handler = vi.fn();
    const wrapped = withValidation(schema, handler, { channel: 'task.create' });

    const big = { blob: 'x'.repeat(MAX_IPC_PAYLOAD_BYTES + 10) };
    const result = await wrapped(fakeEvent, big);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('payload_too_large');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('counts typed-array bytes and honors an explicit bounded binary channel limit', async () => {
    const schema = z.object({ bytes: z.instanceof(Uint8Array) });
    const handler = vi.fn(() => 'accepted');
    const wrapped = withValidation(schema, handler, { channel: 'attachment.ingestBytes', maxPayloadBytes: 16 });

    await expect(wrapped(fakeEvent, { bytes: new Uint8Array(8) })).resolves.toEqual({ ok: true, value: 'accepted' });
    const rejected = await wrapped(fakeEvent, { bytes: new Uint8Array(17) });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('payload_too_large');
  });

  it('returns a typed validation error and never runs the handler', async () => {
    const schema = z.object({ id: z.string().uuid() });
    const handler = vi.fn();
    const wrapped = withValidation(schema, handler, { channel: 'task.get' });

    const result = await wrapped(fakeEvent, { id: 'not-a-uuid' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_failed');
      expect(result.error.issues?.length).toBeGreaterThan(0);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler and wraps the result on valid input', async () => {
    const schema = z.object({ name: z.string() });
    const wrapped = withValidation(schema, (_e, input) => `hi ${input.name}`);

    const result = await wrapped(fakeEvent, { name: 'ada' });

    expect(result).toEqual({ ok: true, value: 'hi ada' });
  });

  it('converts a thrown handler error into a typed IpcError', async () => {
    const schema = z.object({});
    const wrapped = withValidation(schema, () => {
      throw new Error('boom');
    });

    const result = await wrapped(fakeEvent, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('handler_error');
      expect(result.error.message).toBe('boom');
    }
  });
});

describe('IpcRouter', () => {
  function makeIpcMain(): IpcMain & { handlers: Map<string, unknown> } {
    const handlers = new Map<string, unknown>();
    const ipcMain = {
      handle: (channel: string, listener: unknown) => {
        handlers.set(channel, listener);
      },
    } as unknown as IpcMain & { handlers: Map<string, unknown> };
    ipcMain.handlers = handlers;
    return ipcMain;
  }

  it('drops non-allowlisted channels and audits the attempt', () => {
    const audit = recordingAudit();
    const ipcMain = makeIpcMain();
    const router = new IpcRouter({ ipcMain, audit });

    router.handle('evil.channel', z.any(), () => 'nope');

    expect(ipcMain.handlers.has('evil.channel')).toBe(false);
    expect(router.registeredChannels()).toHaveLength(0);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: 'ipc.channel_rejected',
      target: 'evil.channel',
    });
  });

  it('registers allowlisted channels', () => {
    const ipcMain = makeIpcMain();
    const router = new IpcRouter({ ipcMain });

    router.handle('workspace.list', z.void(), () => []);

    expect(ipcMain.handlers.has('workspace.list')).toBe(true);
    expect(router.registeredChannels()).toContain('workspace.list');
  });

  it('emits only redacted payloads to the renderer', () => {
    const ipcMain = makeIpcMain();
    const router = new IpcRouter({ ipcMain });
    const sent: { channel: string; payload: unknown }[] = [];
    const webContents = {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    } as unknown as Electron.WebContents;

    router.emit(webContents, 'audit.appended', {
      action: 'login',
      apiKey: 'sk-live-super-secret',
      placeholder: { token: '{{SECRET:stripe}}' },
    });

    expect(sent).toHaveLength(1);
    const payload = sent[0]?.payload as Record<string, unknown>;
    expect(payload['apiKey']).toBe('[REDACTED]');
    expect(payload['action']).toBe('login');
  });
});
