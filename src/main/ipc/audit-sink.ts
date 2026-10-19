// Minimal audit sink seam the IPC router depends on. The full immutable,
// SQLite-backed audit log lands in task 6; the router only needs to append a
// redacted event when it drops a non-allowlisted channel or rejects a payload.
// Keeping this a narrow interface lets the router be unit-tested with a fake.

export interface AuditSink {
  append(event: {
    actor: string;
    action: string;
    target?: string;
    redactedPayload: unknown;
  }): void;
}

/** A no-op sink for contexts where auditing is not yet wired. */
export const noopAuditSink: AuditSink = {
  append: () => {},
};
