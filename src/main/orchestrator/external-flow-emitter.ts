// The external-flow indicator emit seam (Requirement 21.1 — "display a visual
// indicator ... within 500 milliseconds of the transmission being initiated").
//
// When information is about to be sent to an external model provider or
// service, the DataControlService fires an `ExternalFlowIndicator` through this
// seam so the renderer can surface the "data is leaving the machine" indicator
// naming the target provider. Mirrors the orchestrator's TaskEventEmitter
// pattern: the domain depends only on this narrow interface, the main-process
// composition root wires a concrete relay to the IPC router / renderer
// WebContents, and tests inject a recording fake.
//
// The only channel modeled here is `dataflow.external`, part of the
// EVENT_CHANNELS allowlist, so the concrete relay never emits an un-allowlisted
// channel and the payload is redacted before leaving the main process.

import type { EventChannel } from '@shared/ipc-contract';
import type { ExternalFlowIndicator } from '@shared/domain';

/** The external-flow event channel, narrowed from the IPC contract allowlist. */
export type ExternalFlowChannel = Extract<EventChannel, 'dataflow.external'>;

/**
 * The seam the DataControlService emits the external-flow indicator through.
 * Implementations must deliver the redacted indicator to the renderer promptly
 * (well within the 500 ms budget of Requirement 21.1) and must never throw back
 * into the caller — a failed emit must not fail the flow decision.
 */
export interface ExternalFlowEmitter {
  emit(indicator: ExternalFlowIndicator): void;
}

/**
 * A no-op emitter. The DataControlService defaults to this when no emitter is
 * injected (headless tests), so a flow decision never depends on a renderer
 * being present.
 */
export const noopExternalFlowEmitter: ExternalFlowEmitter = {
  emit(): void {
    // Intentionally does nothing.
  },
};

/**
 * A recording emitter for tests: captures every indicator in order so a test
 * can assert what was surfaced to the renderer, without Electron. Not used in
 * production.
 */
export class RecordingExternalFlowEmitter implements ExternalFlowEmitter {
  readonly emitted: ExternalFlowIndicator[] = [];

  emit(indicator: ExternalFlowIndicator): void {
    this.emitted.push(indicator);
  }
}
