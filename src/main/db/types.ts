import type DatabaseConstructor from 'better-sqlite3';

// Store contract from the design. `transaction` runs a function inside a single
// atomic SQLite transaction; `migrate` advances the schema forward-only and
// atomically per step; `backup`/`restore` move a consistent DB copy in and out.

export type Database = DatabaseConstructor.Database;

/** Transaction handle passed to `Store.transaction`. */
export interface Tx {
  readonly db: Database;
}

/**
 * A single forward-only migration. `version` must be a positive integer and
 * migrations must form a gapless 1..N sequence. `up` runs inside a transaction
 * the runner opens; it must not open or commit its own transaction.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  up(tx: Tx): void;
}

export interface Store {
  transaction<T>(fn: (tx: Tx) => T): T;
  migrate(): Promise<void>;
  backup(destPath: string): Promise<void>;
  restore(srcPath: string): Promise<void>;
  /** Current applied schema version (0 when no migrations have run). */
  schemaVersion(): number;
  /** Underlying handle, for repositories in the same process. */
  readonly db: Database;
  close(): void;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly failedVersion?: number,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}
