import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import {
  WorkspaceNotFoundError,
  WorkspaceService,
  WorkspaceValidationError,
} from '@main/domain/workspace-service';
import { NO_VALUE, SettingsService } from '@main/domain/settings-service';

let workDir: string;
let store: SqliteStore;
let workspaces: WorkspaceService;
let settings: SettingsService;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-domain-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  workspaces = new WorkspaceService(store);
  settings = new SettingsService(store, workspaces);
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('WorkspaceService', () => {
  it('creates a workspace and canonicalizes the root path', () => {
    const ws = workspaces.create({ name: '  My Project  ', rootPath: workDir });
    expect(ws.name).toBe('My Project'); // trimmed
    expect(ws.rootPath).toBe(workDir); // existing absolute dir
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(workspaces.list()).toHaveLength(1);
  });

  it('rejects an empty name and persists nothing', () => {
    expect(() => workspaces.create({ name: '   ', rootPath: workDir })).toThrow(
      WorkspaceValidationError,
    );
    expect(workspaces.list()).toHaveLength(0);
  });

  it('rejects an over-long name', () => {
    const long = 'x'.repeat(256);
    try {
      workspaces.create({ name: long, rootPath: workDir });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceValidationError);
      expect((err as WorkspaceValidationError).field).toBe('name');
    }
  });

  it('rejects an unresolvable root path with a rootPath field error', () => {
    try {
      workspaces.create({ name: 'ok', rootPath: join(workDir, 'missing') });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceValidationError);
      expect((err as WorkspaceValidationError).field).toBe('rootPath');
    }
    expect(workspaces.list()).toHaveLength(0);
  });

  it('lists workspaces ordered by creation ascending', () => {
    const a = workspaces.create({ name: 'A', rootPath: workDir });
    const b = workspaces.create({ name: 'B', rootPath: workDir });
    const ids = workspaces.list().map((w) => w.id);
    expect(ids).toEqual([a.id, b.id]);
  });

  it('selects an existing workspace and persists the active pointer', () => {
    const ws = workspaces.create({ name: 'A', rootPath: workDir });
    workspaces.select(ws.id);
    expect(workspaces.activeWorkspaceId()).toBe(ws.id);
  });

  it('rejects selecting an unknown id and leaves the active workspace unchanged', () => {
    const ws = workspaces.create({ name: 'A', rootPath: workDir });
    workspaces.select(ws.id);
    expect(() =>
      workspaces.select('00000000-0000-0000-0000-000000000000'),
    ).toThrow(WorkspaceNotFoundError);
    expect(workspaces.activeWorkspaceId()).toBe(ws.id);
  });
});

describe('SettingsService precedence', () => {
  it('returns NO_VALUE when nothing is defined', () => {
    expect(settings.resolve('ui.theme')).toBe(NO_VALUE);
  });

  it('resolves global value when no workspace override exists', () => {
    settings.set({ key: 'ui.theme', value: 'dark', scope: 'global' });
    expect(settings.resolve('ui.theme')).toBe('dark');
  });

  it('prefers the active workspace value over global', () => {
    const ws = workspaces.create({ name: 'A', rootPath: workDir });
    settings.set({ key: 'ui.theme', value: 'dark', scope: 'global' });
    workspaces.select(ws.id);
    settings.set({ key: 'ui.theme', value: 'light', scope: 'workspace' });

    expect(settings.resolve('ui.theme')).toBe('light'); // workspace wins
  });

  it('falls back to global when the active workspace has no override', () => {
    const ws = workspaces.create({ name: 'A', rootPath: workDir });
    settings.set({ key: 'ui.density', value: 'compact', scope: 'global' });
    workspaces.select(ws.id);
    expect(settings.resolve('ui.density')).toBe('compact');
  });

  it('refuses a workspace-scoped set when no workspace is active', () => {
    expect(() =>
      settings.set({ key: 'k', value: 1, scope: 'workspace' }),
    ).toThrow();
  });
});
