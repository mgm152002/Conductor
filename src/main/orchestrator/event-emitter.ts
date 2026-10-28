// The event-emit seam the orchestrator streams task progress through
// (Requirement 5.5 — "stream progress events to the renderer within 1 second
// of each step state change").
//
// The orchestrator must emit `task.updated` and `task.stream` events to the
// renderer as a task executes, but it must NOT depend on Electron directly: the
// durable execution path has to be unit-testable without a BrowserWindow. This
// module is the indirection that makes that possible. The orchestrator depends
// only on the narrow {@link TaskEventEmitter} interface; the main-process
// composition root wires a concrete implementation that relays to the IPC
// router / renderer `WebContents`, while tests inject a recording fake and
// assert the exact events emitted.
//
// Only the two task-scoped event channels the renderer subscribes to for live
// execution are modeled here; both are part of the EVENT_CHANNELS allowlist in
// the IPC contract, so the concrete relay never emits an un-allowlisted channel.

import type { EventChannel } from '@shared/ipc-contract';

/**
 * The task-scoped event channels the orchestrator emits on. A subset of the IPC
 * contract's {@link EventChannel} allowlist — `task.updated` (the task's state
 * changed) and `task.stream` (a consumed adapter stream event) — so a caller
 * can never ask the emitter to fire an un-allowlisted channel.
 */
export type TaskEventChannel = Extract<
  EventChannel,
  'task.updated' | 'task.stream' | 'question.requested'
>;

/**
 * The seam the orchestrator emits task progress through. Implementations must
 * deliver synchronously-enqueued, redacted payloads to the renderer; the
 * orchestrator calls {@link emit} on every step state change so the renderer
 * reflects progress within one second (Requirement 5.5). Emitting must never
 * throw back into the execution loop — a failed emit must not fail a step — so
 * concrete implementations swallow transport errors.
 */
export interface TaskEventEmitter {
  emit(channel: TaskEventChannel, payload: unknown): void;
}

/**
 * A no-op emitter. The orchestrator defaults to this when no emitter is
 * injected (e.g. headless tests that do not assert on emissions), so execution
 * never depends on a renderer being present.
 */
export const noopTaskEventEmitter: TaskEventEmitter = {
  emit(): void {
    // Intentionally does nothing.
  },
};

/**
 * A recording emitter for tests: captures every emission in order so a test can
 * assert both the channels fired and their payloads, without Electron. Not used
 * in production.
 */
export class RecordingTaskEventEmitter implements TaskEventEmitter {
  readonly emitted: { channel: TaskEventChannel; payload: unknown }[] = [];

  emit(channel: TaskEventChannel, payload: unknown): void {
    this.emitted.push({ channel, payload });
  }

  /** Every payload emitted on a given channel, in order. */
  payloadsFor(channel: TaskEventChannel): unknown[] {
    return this.emitted
      .filter((e) => e.channel === channel)
      .map((e) => e.payload);
  }
}
