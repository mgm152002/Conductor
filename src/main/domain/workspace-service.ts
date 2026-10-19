import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Store } from '../db/types';
import type { Workspace } from '@shared/domain';

// The workspace service owns workspace creation, listing, and selection plus
// the persisted active-workspace pointer. All validation (name length, path
// canonicalization/existence) happens here and rejects with a field-specific
// error before anything is persisted.

export class WorkspaceValidationError extends Error {
  constructor(
    readonly field: 'name' | 'rootPath' | 'id',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceValidationError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Workspace ${id} not found`);
    this.name = 'WorkspaceNotFoundError';
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateWorkspaceInput {
  name: string;
  rootPath: string;
}

export class WorkspaceService {
  constructor(private readonly store: Store) {}

  /**
   * Create a workspace. Validates the name (1–255 chars) and canonicalizes the
   * root path to an existing absolute directory. Rejects invalid input with a
   * field-specific error and persists nothing on failure.
   */
  create(input: CreateWorkspaceInput): Workspace {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 255) {
      throw new WorkspaceValidationError(
        'name',
        'Workspace name must be between 1 and 255 characters',
      );
    }

    const canonicalPath = this.canonicalizeRoot(input.rootPath);

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      rootPath: canonicalPath,
      createdAt: now,
      updatedAt: now,
    };

    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          workspace.id,
          workspace.name,
          workspace.rootPath,
          workspace.createdAt,
          workspace.updatedAt,
        );
    });

    return workspace;
  }

  private canonicalizeRoot(rootPath: string): string {
    const trimmed = rootPath.trim();
    if (trimmed === '') {
      throw new WorkspaceValidationError('rootPath', 'Root path is required');
    }
    const absolute = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      throw new WorkspaceValidationError(
        'rootPath',
        `Root path does not exist: ${absolute}`,
      );
    }
    if (!stats.isDirectory()) {
      throw new WorkspaceValidationError(
        'rootPath',
        `Root path is not a directory: ${absolute}`,
      );
    }
    return absolute;
  }

  /** List workspaces ordered by creation time ascending (empty list allowed). */
  list(): Workspace[] {
    const rows = this.store.db
      .prepare(
        `SELECT id, name, root_path, created_at, updated_at
         FROM workspaces ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as WorkspaceRow[];
    return rows.map(rowToWorkspace);
  }

  get(id: string): Workspace | undefined {
    const row = this.store.db
      .prepare(
        `SELECT id, name, root_path, created_at, updated_at
         FROM workspaces WHERE id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row === undefined ? undefined : rowToWorkspace(row);
  }

  /**
   * Select the active workspace, persisted across restarts. Rejects an unknown
   * id with a not-found error and leaves the active workspace unchanged.
   */
  select(id: string): void {
    const exists =
      this.store.db
        .prepare('SELECT 1 FROM workspaces WHERE id = ?')
        .get(id) !== undefined;
    if (!exists) {
      throw new WorkspaceNotFoundError(id);
    }
    this.store.db
      .prepare('UPDATE active_workspace SET workspace_id = ? WHERE id = 1')
      .run(id);
  }

  /** The currently active workspace id, or undefined when none is selected. */
  activeWorkspaceId(): string | undefined {
    const row = this.store.db
      .prepare('SELECT workspace_id FROM active_workspace WHERE id = 1')
      .get() as { workspace_id: string | null } | undefined;
    return row?.workspace_id ?? undefined;
  }
}
