import type {
  ConnectorKind,
  ConnectorLifecycle,
  RetrieveResult,
  RetrievedItem,
} from '@shared/connector';

// A scripted connector lifecycle for IngestionWorker tests. Each `retrieve`
// call pops the next scripted batch (so incremental sync / change detection and
// the retry budget can be driven deterministically). `failAuthorize`,
// `failRevoke`, and per-batch `fail` let tests exercise the failure paths
// without any real external source. Nothing here touches the DB or the data
// channel — the worker owns both.

export interface ScriptedBatch {
  /** Items to return, or undefined to throw a retrieval failure. */
  items?: RetrievedItem[];
  nextCursor?: string;
  /** When set, this retrieve attempt throws with this message. */
  fail?: string;
}

export interface FakeConnectorOptions {
  kind?: ConnectorKind;
  batches?: ScriptedBatch[];
  failAuthorize?: string;
  failRevoke?: string;
}

export class FakeConnectorLifecycle implements ConnectorLifecycle {
  readonly kind: ConnectorKind;
  private readonly batches: ScriptedBatch[];
  private readonly failAuthorize: string | undefined;
  private readonly failRevoke: string | undefined;

  authorizeCalls = 0;
  revokeCalls = 0;
  retrieveCalls = 0;
  cursorsSeen: Array<string | undefined> = [];

  constructor(options: FakeConnectorOptions = {}) {
    this.kind = options.kind ?? 'email';
    this.batches = [...(options.batches ?? [])];
    this.failAuthorize = options.failAuthorize;
    this.failRevoke = options.failRevoke;
  }

  async authorize(): Promise<void> {
    this.authorizeCalls += 1;
    if (this.failAuthorize !== undefined) {
      throw new Error(this.failAuthorize);
    }
  }

  async retrieve(cursor: string | undefined): Promise<RetrieveResult> {
    this.retrieveCalls += 1;
    this.cursorsSeen.push(cursor);
    const batch = this.batches.shift();
    if (batch === undefined) {
      return { items: [] };
    }
    if (batch.fail !== undefined) {
      throw new Error(batch.fail);
    }
    return {
      items: batch.items ?? [],
      ...(batch.nextCursor !== undefined ? { nextCursor: batch.nextCursor } : {}),
    };
  }

  async revoke(): Promise<void> {
    this.revokeCalls += 1;
    if (this.failRevoke !== undefined) {
      throw new Error(this.failRevoke);
    }
  }
}
