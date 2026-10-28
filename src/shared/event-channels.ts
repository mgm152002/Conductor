// The main -> renderer event-channel allowlist, deliberately free of any Zod
// (or other npm) dependency so it can be imported by the SANDBOXED preload.
//
// A sandboxed preload's `require` resolves only `electron` and Node built-ins;
// importing a module that transitively pulls in a bare package (e.g. `zod`)
// makes the preload throw "module not found" and abort before the context
// bridge is exposed. `ipc-contract.ts` re-exports these so existing importers
// are unaffected; the preload imports them from here instead.

export const EVENT_CHANNELS = [
  'chat.updated',
  'task.updated',
  'task.stream',
  'approval.requested',
  'question.requested',
  'resume.snapshot',
  'audit.appended',
  'theme.changed',
  // Fired within 500 ms of an external transmission being initiated so the UI
  // can surface the external-flow indicator (Requirement 21.1). The payload is
  // an ExternalFlowIndicator — provider + target + "leaving machine"; it never
  // carries the transmitted content.
  'dataflow.external',
  // Fired when the Proactive_Assistant surfaces a suggestion, so the renderer
  // can present it non-blocking (dismissible, non-modal by default —
  // Requirement 19.2/19.3). The payload is a Suggestion; it never blocks or
  // interrupts the user's current task.
  'suggestion.surfaced',
  // Connector state changes (sync started/finished, health, revocation,
  // deletion) so the Connections screen stays live. Payload: ConnectorEvent.
  'connector.updated',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

export function isEventChannel(channel: string): channel is EventChannel {
  return (EVENT_CHANNELS as readonly string[]).includes(channel);
}
