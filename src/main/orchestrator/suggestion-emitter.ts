// The proactive-suggestion emit seam (Requirement 19.2/19.3 — present a
// suggestion through the user-configured notification channel "without blocking
// or interrupting the user's current task", dismissible and non-modal by
// default).
//
// When the Proactive_Assistant generates a suggestion, it surfaces it through
// this seam so the renderer can present it non-blocking. Mirrors the
// orchestrator's TaskEventEmitter and the DataControlService's
// ExternalFlowEmitter: the domain depends only on this narrow interface, the
// main-process composition root wires a concrete relay to the IPC router /
// renderer WebContents, and tests inject a recording fake.
//
// The only channel modeled here is `suggestion.surfaced`, part of the
// EVENT_CHANNELS allowlist, so the concrete relay never emits an un-allowlisted
// channel. Emitting is fire-and-forget and must never throw back into the
// assistant — surfacing a suggestion must never block or fail generation.

import type { EventChannel } from '@shared/ipc-contract';
import type { Suggestion } from '@shared/domain';

/** The suggestion event channel, narrowed from the IPC contract allowlist. */
export type SuggestionChannel = Extract<EventChannel, 'suggestion.surfaced'>;

/**
 * The seam the Proactive_Assistant surfaces suggestions through. Implementations
 * must deliver the redacted suggestion to the renderer in a non-blocking,
 * non-modal manner (Requirement 19.2/19.3) and must never throw back into the
 * caller — a failed emit must not fail suggestion generation.
 */
export interface SuggestionEmitter {
  emit(suggestion: Suggestion): void;
}

/**
 * A no-op emitter. The Proactive_Assistant defaults to this when no emitter is
 * injected (headless tests), so generating a suggestion never depends on a
 * renderer being present.
 */
export const noopSuggestionEmitter: SuggestionEmitter = {
  emit(): void {
    // Intentionally does nothing.
  },
};

/**
 * A recording emitter for tests: captures every surfaced suggestion in order so
 * a test can assert what was presented to the renderer, without Electron. Not
 * used in production.
 */
export class RecordingSuggestionEmitter implements SuggestionEmitter {
  readonly emitted: Suggestion[] = [];

  emit(suggestion: Suggestion): void {
    this.emitted.push(suggestion);
  }
}
