import type { Store } from '../db/types';
import type { PreferenceScope } from '@shared/domain';
import type { WorkspaceService } from './workspace-service';

// The settings service persists global- and workspace-scoped preferences and
// resolves a key with workspace > global > undefined precedence against the
// currently active workspace. Values are JSON-serializable and stored as text.

/** Sentinel the resolver returns when no value is defined at any scope. */
export const NO_VALUE = Symbol('no_value_defined');
export type ResolvedPreference = unknown | typeof NO_VALUE;

const GLOBAL_WORKSPACE_ID = '';

export class SettingsService {
  constructor(
    private readonly store: Store,
    private readonly workspaces: WorkspaceService,
  ) {}

  /** Set a preference at the given scope. Workspace scope targets the active workspace. */
  set(input: { key: string; value: unknown; scope: PreferenceScope }): void {
    const key = input.key.trim();
    if (key === '') {
      throw new Error('Preference key is required');
    }

    let workspaceId = GLOBAL_WORKSPACE_ID;
    if (input.scope === 'workspace') {
      const active = this.workspaces.activeWorkspaceId();
      if (active === undefined) {
        throw new Error(
          'Cannot set a workspace-scoped preference: no active workspace',
        );
      }
      workspaceId = active;
    }

    const valueJson = JSON.stringify(input.value ?? null);
    this.store.db
      .prepare(
        `INSERT INTO preferences (scope, workspace_id, key, value_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (scope, workspace_id, key)
         DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(input.scope, workspaceId, key, valueJson);
  }

  /**
   * Resolve a key as the workspace-scoped value for the active workspace, else
   * the global value, else NO_VALUE. Returns the parsed JSON value.
   */
  resolve(key: string): ResolvedPreference {
    const activeId = this.workspaces.activeWorkspaceId();
    if (activeId !== undefined) {
      const wsValue = this.readRaw('workspace', activeId, key);
      if (wsValue !== undefined) {
        return JSON.parse(wsValue) as unknown;
      }
    }
    const globalValue = this.readRaw('global', GLOBAL_WORKSPACE_ID, key);
    if (globalValue !== undefined) {
      return JSON.parse(globalValue) as unknown;
    }
    return NO_VALUE;
  }

  private readRaw(
    scope: PreferenceScope,
    workspaceId: string,
    key: string,
  ): string | undefined {
    const row = this.store.db
      .prepare(
        `SELECT value_json FROM preferences
         WHERE scope = ? AND workspace_id = ? AND key = ?`,
      )
      .get(scope, workspaceId, key) as { value_json: string } | undefined;
    return row?.value_json;
  }
}
