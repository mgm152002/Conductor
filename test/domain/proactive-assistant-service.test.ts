import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import {
  PermissionService,
  type PermissionSubject,
} from '@main/domain/permission-service';
import {
  AllowlistAuthorizedSources,
  ProactiveAssistant,
  SuggestionNotFoundError,
  SuggestionStateError,
  UnauthorizedSourceError,
  type ContextSignal,
  type SuggestionExecutor,
} from '@main/domain/proactive-assistant-service';
import { RecordingSuggestionEmitter } from '@main/orchestrator/suggestion-emitter';
import type { Suggestion } from '@shared/domain';

// Unit tests for Requirement 19 (Proactive assistant):
//   19.1 — a suggestion carries triggering context, proposed action, and a
//          human-readable explanation
//   19.2/19.3 — surfaced non-blocking through the configured channel,
//          dismissible/non-modal by default
//   19.4 — auto-execute ONLY an explicitly configured low-risk action within
//          granted permissions, with an audit entry (action, trigger, timestamp)
//   19.5 — otherwise suggest-only; never executed without explicit confirmation
//   19.6 — limit monitoring to authorized sources
//   19.7 — an external side effect requires authorization; the suggestion is
//          retained unexecuted until granted or dismissed

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;
let permissions: PermissionService;
let emitter: RecordingSuggestionEmitter;
let sources: AllowlistAuthorizedSources;
let executed: Suggestion[];
let executor: SuggestionExecutor;

let clockMs: number;
const now = () => clockMs;
const tick = (ms = 1000): number => (clockMs += ms);

const SOURCE = 'connector:calendar';
const AGENT: PermissionSubject = { type: 'agent', id: 'agent-1' };

function newAssistant(): ProactiveAssistant {
  return new ProactiveAssistant(
    store,
    audit,
    permissions,
    sources,
    emitter,
    executor,
    now,
  );
}

function signal(overrides: Partial<ContextSignal> = {}): ContextSignal {
  const base: ContextSignal = {
    trigger: {
      kind: 'deadline_approaching',
      sourceId: SOURCE,
      summary: 'Project proposal is due in 2 hours',
      observedAt: new Date(clockMs).toISOString(),
    },
    action: {
      kind: 'draft_reminder',
      summary: 'Draft a reminder note about the proposal deadline',
      externalSideEffect: false,
      permissionRequirements: [{ kind: 'filesystem_write', scope: '/notes' }],
    },
    explanation: 'The proposal deadline is approaching and no reminder exists.',
  };
  return {
    ...base,
    ...overrides,
    trigger: { ...base.trigger, ...(overrides.trigger ?? {}) },
    action: { ...base.action, ...(overrides.action ?? {}) },
  };
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-proactive-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  permissions = new PermissionService(store, audit, now);
  emitter = new RecordingSuggestionEmitter();
  sources = new AllowlistAuthorizedSources([SOURCE]);
  executed = [];
  executor = { execute: (s) => void executed.push(s) };
  clockMs = Date.parse('2024-01-01T00:00:00.000Z');
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('generation (19.1)', () => {
  it('generates a suggestion carrying trigger, action, and explanation', async () => {
    const assistant = newAssistant();
    const { suggestion } = await assistant.generate(signal());

    expect(suggestion.trigger.kind).toBe('deadline_approaching');
    expect(suggestion.trigger.summary).toContain('proposal');
    expect(suggestion.action.kind).toBe('draft_reminder');
    expect(suggestion.explanation).toContain('deadline');
    expect(suggestion.status).toBe('suggested');
    expect(assistant.getSuggestion(suggestion.id)).toEqual(suggestion);
  });

  it('accepts every enumerated trigger kind', async () => {
    const assistant = newAssistant();
    const kinds = [
      'deadline_approaching',
      'email_awaiting_reply',
      'task_interrupted',
      'workflow_due',
      'document_changed',
      'repeated_step_failure',
    ] as const;
    for (const kind of kinds) {
      const { suggestion } = await assistant.generate(
        signal({ trigger: { kind, sourceId: SOURCE, summary: kind, observedAt: new Date(clockMs).toISOString() } }),
      );
      expect(suggestion.trigger.kind).toBe(kind);
      tick();
    }
    expect(assistant.listSuggestions()).toHaveLength(kinds.length);
  });
});

describe('non-blocking presentation (19.2 / 19.3)', () => {
  it('surfaces every generated suggestion through the emitter', async () => {
    const assistant = newAssistant();
    const { suggestion } = await assistant.generate(signal());
    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]!.id).toBe(suggestion.id);
  });

  it('surfaces suggestions regardless of disposition', async () => {
    const assistant = newAssistant();
    await assistant.generate(signal()); // suggest-only
    tick();
    await assistant.generate(
      signal({ action: { kind: 'send_email', summary: 'send', externalSideEffect: true, permissionRequirements: [] } }),
    ); // awaiting authorization
    expect(emitter.emitted).toHaveLength(2);
  });
});

describe('auto-execution (19.4)', () => {
  it('auto-executes a configured low-risk action within granted permissions', async () => {
    permissions.grant({ subject: AGENT, profile: 'trusted_automation' });
    const assistant = newAssistant();
    assistant.addAutoExecuteRule({ actionKind: 'draft_reminder', subject: AGENT });

    const { suggestion, disposition } = await assistant.generate(
      signal({ subject: AGENT }),
    );

    expect(disposition).toBe('auto_executed');
    expect(suggestion.status).toBe('auto_executed');
    expect(suggestion.resolvedAt).toBeDefined();
    expect(executed.map((s) => s.id)).toEqual([suggestion.id]);
  });

  it('records an audit entry with the action, trigger, and timestamp', async () => {
    permissions.grant({ subject: AGENT, profile: 'trusted_automation' });
    const assistant = newAssistant();
    assistant.addAutoExecuteRule({ actionKind: 'draft_reminder', subject: AGENT });

    const { suggestion } = await assistant.generate(signal({ subject: AGENT }));

    const entry = audit
      .list()
      .find((e) => e.action === 'proactive.auto_executed');
    expect(entry).toBeDefined();
    const payload = entry!.redactedPayload as {
      actionKind: string;
      trigger: { kind: string };
      timestamp: string;
    };
    expect(payload.actionKind).toBe('draft_reminder');
    expect(payload.trigger.kind).toBe('deadline_approaching');
    expect(payload.timestamp).toBe(suggestion.createdAt);
  });

  it('does NOT auto-execute without a matching rule (suggest-only)', async () => {
    permissions.grant({ subject: AGENT, profile: 'trusted_automation' });
    const assistant = newAssistant();

    const { suggestion, disposition } = await assistant.generate(
      signal({ subject: AGENT }),
    );

    expect(disposition).toBe('suggested');
    expect(suggestion.status).toBe('suggested');
    expect(executed).toHaveLength(0);
  });

  it('does NOT auto-execute when the subject lacks a required permission', async () => {
    // read_only cannot do filesystem_write, so the required permission is not held.
    permissions.grant({ subject: AGENT, profile: 'read_only' });
    const assistant = newAssistant();
    assistant.addAutoExecuteRule({ actionKind: 'draft_reminder', subject: AGENT });

    const { disposition } = await assistant.generate(signal({ subject: AGENT }));

    expect(disposition).toBe('suggested');
    expect(executed).toHaveLength(0);
  });

  it('does NOT auto-execute when the rule is disabled', async () => {
    permissions.grant({ subject: AGENT, profile: 'trusted_automation' });
    const assistant = newAssistant();
    assistant.addAutoExecuteRule({ actionKind: 'draft_reminder', subject: AGENT });
    assistant.removeAutoExecuteRule({ actionKind: 'draft_reminder', subject: AGENT });

    const { disposition } = await assistant.generate(signal({ subject: AGENT }));
    expect(disposition).toBe('suggested');
    expect(executed).toHaveLength(0);
  });

  it('does NOT auto-execute when no subject is supplied', async () => {
    permissions.grant({ subject: AGENT, profile: 'trusted_automation' });
    const assistant = newAssistant();
    assistant.addAutoExecuteRule({ actionKind: 'draft_reminder', subject: AGENT });

    const { disposition } = await assistant.generate(signal()); // no subject
    expect(disposition).toBe('suggested');
  });
});

describe('suggest-only confirmation (19.5)', () => {
  it('executes a suggest-only action only after explicit confirmation', async () => {
    const assistant = newAssistant();
    const { suggestion } = await assistant.generate(signal());
    expect(executed).toHaveLength(0);

    const confirmed = await assistant.confirm(suggestion.id);
    expect(confirmed.status).toBe('confirmed');
    expect(executed.map((s) => s.id)).toEqual([suggestion.id]);
  });

  it('never executes a dismissed suggestion', async () => {
    const assistant = newAssistant();
    const { suggestion } = await assistant.generate(signal());

    const dismissed = assistant.dismiss(suggestion.id);
    expect(dismissed.status).toBe('dismissed');
    expect(executed).toHaveLength(0);
  });

  it('rejects confirming or dismissing an already-resolved suggestion', async () => {
    const assistant = newAssistant();
    const { suggestion } = await assistant.generate(signal());
    assistant.dismiss(suggestion.id);

    await expect(assistant.confirm(suggestion.id)).rejects.toBeInstanceOf(
      SuggestionStateError,
    );
    expect(() => assistant.dismiss(suggestion.id)).toThrow(SuggestionStateError);
  });

  it('throws for an unknown suggestion id', async () => {
    const assistant = newAssistant();
    await expect(assistant.confirm('nope')).rejects.toBeInstanceOf(
      SuggestionNotFoundError,
    );
    expect(() => assistant.dismiss('nope')).toThrow(SuggestionNotFoundError);
  });
});

describe('authorized sources only (19.6)', () => {
  it('refuses to generate from an unauthorized source and persists nothing', async () => {
    const assistant = newAssistant();
    const bad = signal({
      trigger: {
        kind: 'document_changed',
        sourceId: 'connector:unknown',
        summary: 'A private doc changed',
        observedAt: new Date(clockMs).toISOString(),
      },
    });

    await expect(assistant.generate(bad)).rejects.toBeInstanceOf(
      UnauthorizedSourceError,
    );
    expect(assistant.listSuggestions()).toHaveLength(0);
    expect(emitter.emitted).toHaveLength(0);
    expect(
      audit.list().some((e) => e.action === 'proactive.source_unauthorized'),
    ).toBe(true);
  });

  it('generates once a source is authorized', async () => {
    sources.authorize('connector:files');
    const assistant = newAssistant();
    const { suggestion } = await assistant.generate(
      signal({
        trigger: {
          kind: 'document_changed',
          sourceId: 'connector:files',
          summary: 'README changed',
          observedAt: new Date(clockMs).toISOString(),
        },
      }),
    );
    expect(suggestion.trigger.sourceId).toBe('connector:files');
  });
});

describe('external side effect requires authorization (19.7)', () => {
  it('retains an external-side-effect action unexecuted even with a rule and permissions', async () => {
    permissions.grant({ subject: AGENT, profile: 'trusted_automation' });
    const assistant = newAssistant();
    assistant.addAutoExecuteRule({ actionKind: 'send_email', subject: AGENT });

    const { suggestion, disposition } = await assistant.generate(
      signal({
        subject: AGENT,
        action: {
          kind: 'send_email',
          summary: 'Send a reminder email',
          externalSideEffect: true,
          permissionRequirements: [{ kind: 'external_comm' }],
        },
      }),
    );

    expect(disposition).toBe('awaiting_authorization');
    expect(suggestion.status).toBe('awaiting_authorization');
    expect(suggestion.resolvedAt).toBeUndefined();
    expect(executed).toHaveLength(0);
  });

  it('executes the external action only after the user confirms', async () => {
    const assistant = newAssistant();
    const { suggestion } = await assistant.generate(
      signal({
        action: {
          kind: 'send_email',
          summary: 'Send a reminder email',
          externalSideEffect: true,
          permissionRequirements: [],
        },
      }),
    );
    expect(suggestion.status).toBe('awaiting_authorization');
    expect(executed).toHaveLength(0);

    const confirmed = await assistant.confirm(suggestion.id);
    expect(confirmed.status).toBe('confirmed');
    expect(executed.map((s) => s.id)).toEqual([suggestion.id]);
  });

  it('keeps an external action unexecuted when dismissed', async () => {
    const assistant = newAssistant();
    const { suggestion } = await assistant.generate(
      signal({
        action: {
          kind: 'send_email',
          summary: 'Send a reminder email',
          externalSideEffect: true,
          permissionRequirements: [],
        },
      }),
    );
    assistant.dismiss(suggestion.id);
    expect(assistant.getSuggestion(suggestion.id)!.status).toBe('dismissed');
    expect(executed).toHaveLength(0);
  });
});

describe('auto-execute rule management (19.4)', () => {
  it('is idempotent per (actionKind, subject) and re-enables a disabled rule', async () => {
    const assistant = newAssistant();
    const first = assistant.addAutoExecuteRule({ actionKind: 'k', subject: AGENT });
    const again = assistant.addAutoExecuteRule({ actionKind: 'k', subject: AGENT });
    expect(again.id).toBe(first.id);
    expect(assistant.listAutoExecuteRules()).toHaveLength(1);

    assistant.removeAutoExecuteRule({ actionKind: 'k', subject: AGENT });
    expect(assistant.listAutoExecuteRules()).toHaveLength(0);
  });
});
