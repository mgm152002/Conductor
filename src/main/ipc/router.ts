import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { z } from 'zod';
import {
  isInvokeChannel,
  MAX_IPC_PAYLOAD_BYTES,
  type EventChannel,
  type InvokeChannel,
  type IpcError,
  type IpcResult,
} from '@shared/ipc-contract';
import type { AuditSink } from './audit-sink';
import { noopAuditSink } from './audit-sink';
import { redact } from './redaction';

// The validated IPC surface. `withValidation` is the single wrapper every
// handler passes through:
//   1. reject payloads over 1 MiB *before* parsing (cheap DoS guard),
//   2. parse with the channel's Zod schema, returning a typed error on failure
//      without ever running the handler,
//   3. run the handler and wrap its result as IpcSuccess,
//   4. convert thrown handler errors into a typed IpcError.
//
// The router additionally drops any channel outside the allowlist, auditing the
// attempt, and only ever emits redacted payloads to the renderer.

function byteLength(payload: unknown): number {
  if (payload === undefined) {
    return 0;
  }
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
  } catch {
    // Unserializable payload (e.g. a cycle) — treat as oversized to be safe.
    return MAX_IPC_PAYLOAD_BYTES + 1;
  }
}

function fail(error: IpcError['error']): IpcError {
  return { ok: false, error };
}

export type ValidatedHandler<TIn, TOut> = (
  event: IpcMainInvokeEvent,
  input: TIn,
) => Promise<TOut> | TOut;

/**
 * Wrap a handler with size-limit enforcement and Zod validation. The returned
 * function is what gets registered with `ipcMain.handle`; it always resolves
 * to an `IpcResult` and never throws across the IPC boundary.
 */
export function withValidation<TSchema extends z.ZodTypeAny, TOut>(
  schema: TSchema,
  handler: ValidatedHandler<z.infer<TSchema>, TOut>,
  options: { channel?: string; audit?: AuditSink } = {},
): (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResult<TOut>> {
  const audit = options.audit ?? noopAuditSink;
  const channel = options.channel;

  return async (event, payload): Promise<IpcResult<TOut>> => {
    if (byteLength(payload) > MAX_IPC_PAYLOAD_BYTES) {
      audit.append({
        actor: 'orchestrator',
        action: 'ipc.payload_too_large',
        ...(channel !== undefined ? { target: channel } : {}),
        redactedPayload: { bytes: 'over_limit' },
      });
      return fail({
        code: 'payload_too_large',
        message: `Payload exceeds ${MAX_IPC_PAYLOAD_BYTES} bytes`,
        ...(channel !== undefined ? { channel } : {}),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return fail({
        code: 'validation_failed',
        message: 'Payload failed validation',
        ...(channel !== undefined ? { channel } : {}),
        issues,
      });
    }

    try {
      const value = await handler(event, parsed.data as z.infer<TSchema>);
      return { ok: true, value };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Handler failed';
      return fail({
        code: 'handler_error',
        message,
        ...(channel !== undefined ? { channel } : {}),
      });
    }
  };
}

export interface RouterDeps {
  ipcMain: IpcMain;
  audit?: AuditSink;
}

/**
 * The IpcRouter registers validated handlers on allowlisted channels only and
 * emits redacted events to a target WebContents. Registering a non-allowlisted
 * channel is refused and audited; the handler is never installed.
 */
export class IpcRouter {
  private readonly ipcMain: IpcMain;
  private readonly audit: AuditSink;
  private readonly registered = new Set<InvokeChannel>();

  constructor(deps: RouterDeps) {
    this.ipcMain = deps.ipcMain;
    this.audit = deps.audit ?? noopAuditSink;
  }

  /**
   * Register a validated handler for an allowlisted invoke channel. Pass the
   * channel's schema from `INVOKE_SCHEMAS`.
   */
  handle<TSchema extends z.ZodTypeAny, TOut>(
    channel: string,
    schema: TSchema,
    handler: ValidatedHandler<z.infer<TSchema>, TOut>,
  ): void {
    if (!isInvokeChannel(channel)) {
      this.audit.append({
        actor: 'orchestrator',
        action: 'ipc.channel_rejected',
        target: channel,
        redactedPayload: { reason: 'not_in_allowlist' },
      });
      return;
    }
    this.registered.add(channel);
    this.ipcMain.handle(
      channel,
      withValidation(schema, handler, { channel, audit: this.audit }),
    );
  }

  /** Emit a redacted event to the renderer over an allowlisted event channel. */
  emit(target: WebContents, channel: EventChannel, payload: unknown): void {
    target.send(channel, redact(payload));
  }

  /** Channels that have been successfully registered (for tests/diagnostics). */
  registeredChannels(): InvokeChannel[] {
    return [...this.registered];
  }
}
