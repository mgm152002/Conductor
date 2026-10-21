import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionProfile } from '@shared/domain';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { PermissionService } from '@main/domain/permission-service';
import { AuditLog } from '@main/domain/audit-log';
import { Registry } from '@main/registry/registry';
import { CliRegistrar } from '@main/catalog/registrar';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import { Orchestrator } from '@main/orchestrator/orchestrator';
import { TaskRunner } from '@main/orchestrator/task-runner';
import { evidenceEvaluator } from '@main/orchestrator/evidence-evaluator';
import { RecordingTaskEventEmitter } from '@main/orchestrator/event-emitter';
import { ToolApprovalBroker } from '@main/orchestrator/tool-approvals';
import { replyFor } from '@main/orchestrator/thread-context';
import { ToolGate, isSensitivePath } from '@main/adapters/tool-gate';
import { classifyAgyTool } from '@main/adapters/antigravity-adapter';
import { acpGateRequest, acpOutcome } from '@main/adapters/acp-agent-adapter';
import { claudeGateRequest } from '@main/adapters/claude-code-adapter';
import { UsageRecorder } from '@main/usage/usage';

// Every agent CLI asks per tool call: Claude Code (permission prompt tool over
// MCP), Antigravity (PreToolUse hook), OpenCode and Kiro (ACP
// session/request_permission). Fixtures speak each real protocol.

const FIXTURES = {
  'claude-code': resolve(__dirname, '../fixtures/claude-permission-fixture.mjs'),
  antigravity: resolve(__dirname, '../fixtures/agy-hook-fixture.mjs'),
  opencode: resolve(__dirname, '../fixtures/acp-agent-fixture.mjs'),
  kiro: resolve(__dirname, '../fixtures/acp-agent-fixture.mjs'),
} as const;
type AgentId = keyof typeof FIXTURES;
const NAMES: Record<AgentId, string> = { 'claude-code': 'Claude Code', antigravity: 'Antigravity', opencode: 'OpenCode', kiro: 'Kiro CLI' };

const roots: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function setup(agent: AgentId, mode: PermissionProfile = 'assisted_execution', options: { autoApprove?: () => boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `conductor-${agent}-`));
  roots.push(root);
  const binary = join(root, `${agent}-bin`);
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURES[agent]}" "$@"\n`);
  chmodSync(binary, 0o755);
  const store = new SqliteStore(':memory:');
  stores.push(store);
  await store.migrate();
  const workspaces = new WorkspaceService(store);
  const workspace = workspaces.create({ name: 'W', rootPath: root });
  const audit = new AuditLog(store);
  const permissions = new PermissionService(store, audit);
  permissions.grant({ subject: { type: 'agent', id: 'orchestrator' }, profile: mode });
  const registry = new Registry();
  const broker = new ToolApprovalBroker(store, permissions);
  const result = new CliRegistrar(registry, undefined, undefined, (request, signal) => broker.request(request, signal), options.autoApprove)
    .ensureRegistered({ id: agent, displayName: NAMES[agent], candidateBinaryNames: [binary], installMethod: { kind: 'unconfigured' } }, binary);
  expect(result).toEqual({ kind: 'registered' });
  const machine = new TaskStateMachine(store, audit);
  const canceller = new TaskCanceller(store, machine, registry, audit);
  const emitter = new RecordingTaskEventEmitter();
  const orchestrator = new Orchestrator(store, machine, workspaces, canceller, audit, {
    registry, permissions, emitter, maxStepRetries: 0, criterionEvaluator: evidenceEvaluator(store), usage: new UsageRecorder(store),
    executionInput: (task) => ({ objective: task.objective, rootPath: root, mode, models: { opencode: 'm/pinned' } }),
  });
  const runner = new TaskRunner({ store, orchestrator, stateMachine: machine, permissions, registry, audit, emitter, toolApprovals: broker });
  return { store, runner, machine, permissions, workspace, orchestrator, root, registry };
}

async function waitForApproval(permissions: PermissionService, taskId: string) {
  for (let i = 0; i < 400; i += 1) {
    const pending = permissions.pendingApprovals(taskId);
    if (pending.length > 0) return pending[0]!;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no approval requested');
}

describe.each([
  ['claude-code', 'Claude Code wants to run a command (Create notes)', 'decision=allow', 'decision=deny'],
  ['antigravity', 'Antigravity wants to run a command (Create notes)', 'read=allow first=allow second=allow', 'read=allow first=deny'],
  ['opencode', 'OpenCode wants to run a command', 'decision=once config=ask', 'decision=reject config=ask'],
  ['kiro', 'Kiro CLI wants to run a command', 'decision=once config=none', 'decision=reject config=none'],
] as const)('%s asks per tool call', (agent, summary, approvedReply, deniedReply) => {
  it('starts without an up-front approval and asks only for the command', async () => {
    const { runner, machine, permissions, workspace, store } = await setup(agent);
    const task = await runner.create({ workspaceId: workspace.id, objective: 'make notes', acceptanceCriteria: [`contains: ${approvedReply}`] });
    const approval = await waitForApproval(permissions, task.id);
    expect(machine.getTask(task.id)?.state).toBe('RUNNING');
    expect(approval.summary).toContain(summary);
    expect(approval.summary).toContain('touch notes.txt');
    expect(approval.requirements).toEqual([{ kind: 'command_exec', scope: 'touch notes.txt' }]);
    // "Allow for this task": a repeat of the same command is not asked again.
    await runner.resolveApproval({ approvalId: approval.id, decision: 'approved', remember: true });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('COMPLETED');
    expect(replyFor(store, task.id)).toContain(approvedReply);
    expect(replyFor(store, task.id)).toContain('prompt=make notes');
    const asked = store.db.prepare('SELECT COUNT(*) AS n FROM approval_requests WHERE task_id = ?').get(task.id) as { n: number };
    expect(asked.n).toBe(1);
  }, 30_000);

  it('declines only that action when the user denies it; the task continues', async () => {
    const { runner, machine, permissions, workspace, store } = await setup(agent);
    const task = await runner.create({ workspaceId: workspace.id, objective: 'make notes', acceptanceCriteria: [`contains: ${deniedReply}`] });
    const approval = await waitForApproval(permissions, task.id);
    await runner.resolveApproval({ approvalId: approval.id, decision: 'denied' });
    if (agent === 'antigravity') {
      // The second, identical command is asked again after a plain deny.
      await runner.resolveApproval({ approvalId: (await waitForApproval(permissions, task.id)).id, decision: 'denied' });
    }
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('COMPLETED');
    expect(replyFor(store, task.id)).toContain(deniedReply);
  }, 30_000);

  it('expires an open tool approval when the task is cancelled', async () => {
    const { runner, permissions, workspace, machine, orchestrator } = await setup(agent);
    const task = await runner.create({ workspaceId: workspace.id, objective: 'make notes' });
    const approval = await waitForApproval(permissions, task.id);
    await orchestrator.cancelTask(task.id);
    await runner.waitForIdle(task.id);
    expect(permissions.getApproval(approval.id)?.status).toBe('expired');
    expect(machine.getTask(task.id)?.state).toBe('CANCELLED');
  }, 30_000);
});

describe('trusted automation never asks', () => {
  it.each([
    ['claude-code', 'decision=allow'],
    ['antigravity', 'nohook read=allow first=allow'],
    ['opencode', 'decision=once config=none'],
  ] as const)('%s', async (agent, reply) => {
    const { runner, machine, workspace, store, root } = await setup(agent, 'trusted_automation');
    const task = await runner.create({ workspaceId: workspace.id, objective: 'make notes', acceptanceCriteria: [`contains: ${reply}`] });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('COMPLETED');
    expect(replyFor(store, task.id)).toContain(reply);
    if (agent === 'claude-code') {
      expect(existsSync(join(root, 'notes.txt'))).toBe(true);
      // Usage from the JSON result envelope (input includes cache reads and writes).
      expect(store.db.prepare('SELECT model, input_tokens, cached_input_tokens, output_tokens, total_tokens, cost_usd FROM agent_usage WHERE task_id = ?').get(task.id))
        .toEqual({ model: 'claude-test-model', input_tokens: 100, cached_input_tokens: 60, output_tokens: 12, total_tokens: 112, cost_usd: 0.0125 });
    }
    const asked = store.db.prepare('SELECT COUNT(*) AS n FROM approval_requests WHERE task_id = ?').get(task.id) as { n: number };
    expect(asked.n).toBe(0);
  }, 30_000);
});

describe('auto-approve everything never asks', () => {
  it.each([
    ['claude-code', 'decision=allow'],
    ['antigravity', 'read=allow first=allow second=allow'],
    ['opencode', 'decision=once config=ask'],
    ['kiro', 'decision=once config=none'],
  ] as const)('%s', async (agent, reply) => {
    const { runner, machine, workspace, store } = await setup(agent, 'assisted_execution', { autoApprove: () => true });
    const task = await runner.create({ workspaceId: workspace.id, objective: 'make notes', acceptanceCriteria: [`contains: ${reply}`] });
    await runner.waitForIdle(task.id);
    expect(machine.getTask(task.id)?.state).toBe('COMPLETED');
    expect(replyFor(store, task.id)).toContain(reply);
    const asked = store.db.prepare('SELECT COUNT(*) AS n FROM approval_requests WHERE task_id = ?').get(task.id) as { n: number };
    expect(asked.n).toBe(0);
  }, 30_000);
});

describe('tool-call classification', () => {
  it('lets Antigravity read inside the workspace and asks for everything else', () => {
    expect(classifyAgyTool('view_file', { AbsolutePath: '/w/src/a.ts' }, '/w', false)).toEqual({ allow: true });
    expect(classifyAgyTool('view_file', { AbsolutePath: '/etc/passwd' }, '/w', false))
      .toMatchObject({ allow: false, request: { kind: 'permissions', detail: '/etc/passwd' } });
    expect(classifyAgyTool('list_dir', { DirectoryPath: '~/.ssh' }, '/w', true)).toMatchObject({ allow: false });
    expect(classifyAgyTool('run_command', { CommandLine: 'npm test' }, '/w', false))
      .toMatchObject({ allow: false, request: { kind: 'command', detail: 'npm test' } });
    expect(classifyAgyTool('write_to_file', { TargetFile: '/w/a.ts', CodeContent: 'x' }, '/w', false))
      .toMatchObject({ allow: false, request: { kind: 'file_change', detail: '/w/a.ts' } });
    expect(classifyAgyTool('call_mcp_tool', { ServerName: 's' }, '/w', false)).toMatchObject({ allow: false, request: { kind: 'permissions' } });
    expect(classifyAgyTool('read_file', { Path: '/w/README.md' }, '/w', true)).toEqual({ allow: true });
    expect(classifyAgyTool('run_command', { CommandLine: 'rm -rf build' }, '/w', true)).toEqual({ allow: 'never' });
  });

  it('runs simple read-only Antigravity commands without asking', () => {
    for (const ok of ['ls -la', 'git status', 'cat src/a.ts', 'grep -n foo /w/src', 'find . -name "*.ts"']) {
      expect(classifyAgyTool('run_command', { CommandLine: ok }, '/w', false), ok).toEqual({ allow: true });
    }
    for (const ask of ['ls; rm -rf x', 'cat a > b', 'echo $(id)', 'cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'cat ../x', 'cat .env',
      'find . -delete', 'find . -exec rm {} +', 'git push', 'npm test', 'git diff --output=x']) {
      expect(classifyAgyTool('run_command', { CommandLine: ask }, '/w', false), ask).toMatchObject({ allow: false });
    }
  });

  it('maps Claude Code tools to approval kinds', () => {
    expect(claudeGateRequest('Bash', { command: 'ls -la' })).toMatchObject({ kind: 'command', detail: 'ls -la' });
    expect(claudeGateRequest('Write', { file_path: '/w/a.ts' })).toMatchObject({ kind: 'file_change', detail: '/w/a.ts' });
    expect(claudeGateRequest('WebFetch', { url: 'https://x.test' })).toMatchObject({ kind: 'permissions', detail: 'https://x.test' });
    expect(claudeGateRequest('mcp__gh__create_issue', { title: 't' })).toMatchObject({ kind: 'permissions', summary: 'Claude Code wants to use mcp__gh__create_issue' });
  });

  it('treats reads and searches as approval-free except sensitive files', () => {
    expect(acpGateRequest('OpenCode', { kind: 'read', title: 'Read', locations: [{ path: '/w/src/a.ts' }] }).readOnly).toBe(true);
    expect(acpGateRequest('OpenCode', { kind: 'search', title: 'Search', rawInput: { path: '/w/src' } }).readOnly).toBe(true);
    expect(acpGateRequest('OpenCode', { kind: 'read', title: 'Read', locations: [{ path: '/w/.env' }] }).readOnly).toBe(false);
    expect(claudeGateRequest('Read', { file_path: '/w/src/a.ts' }).readOnly).toBe(true);
    expect(claudeGateRequest('Grep', { pattern: 'needle' }).readOnly).toBe(true);
    expect(claudeGateRequest('Read', { file_path: '/w/.env.local' }).readOnly).toBe(false);
    for (const path of ['/w/.env', '/w/.env.local', '/w/id_rsa', '/w/id_ed25519.pub', '/w/cert.pem', '/w/server.key', '/w/cert.p12', '/w/cert.pfx']) {
      expect(isSensitivePath(path), path).toBe(true);
    }
    expect(isSensitivePath('/w/src/a.ts')).toBe(false);
  });

  it('maps ACP tool calls and answers with an offered option', () => {
    expect(acpGateRequest('Kiro CLI', { kind: 'execute', title: 'Run', rawInput: { command: ['npm', 'test'] } })).toMatchObject({ kind: 'command', detail: 'npm test' });
    expect(acpGateRequest('OpenCode', { kind: 'edit', title: 'edit a.ts', locations: [{ path: '/w/a.ts' }] })).toMatchObject({ kind: 'file_change', detail: '/w/a.ts' });
    const options = [{ optionId: 'a1', kind: 'allow_once' }, { optionId: 'a2', kind: 'allow_always' }, { optionId: 'r1', kind: 'reject_once' }];
    expect(acpOutcome(options, 'accept')).toEqual({ outcome: { outcome: 'selected', optionId: 'a1' } });
    // "Allow for this task" stays in Conductor; the agent is not told to persist a rule.
    expect(acpOutcome(options, 'accept_for_session')).toEqual({ outcome: { outcome: 'selected', optionId: 'a1' } });
    expect(acpOutcome(options, 'decline')).toEqual({ outcome: { outcome: 'selected', optionId: 'r1' } });
    expect(acpOutcome(options, 'cancel')).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(acpOutcome([{ optionId: 'a1', kind: 'allow_once' }], 'decline')).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('decides by permission profile', async () => {
    const asked: string[] = [];
    const approver = async () => { asked.push('x'); return 'accept_for_session' as const; };
    const ids = { taskId: 't', stepId: 's' };
    expect(await new ToolGate('read_only', approver, ids).decide({ kind: 'command', summary: 's', detail: 'ls' })).toBe('decline');
    expect(await new ToolGate('trusted_automation', approver, ids).decide({ kind: 'command', summary: 's', detail: 'ls' })).toBe('accept');
    const gate = new ToolGate('assisted_execution', approver, ids);
    expect(await gate.decide({ kind: 'command', summary: 's', detail: 'ls' })).toBe('accept_for_session');
    expect(await gate.decide({ kind: 'command', summary: 's', detail: 'ls' })).toBe('accept');
    expect(asked).toHaveLength(1);
  });

  it('auto-accepts reads and searches, but keeps sensitive reads gated unless auto-approve is on', async () => {
    let asked = 0;
    const approver = async () => { asked += 1; return 'decline' as const; };
    const ids = { taskId: 't', stepId: 's' };
    const gate = new ToolGate('assisted_execution', approver, ids);
    expect(await gate.decide(claudeGateRequest('Read', { file_path: '/w/src/a.ts' }))).toBe('accept');
    expect(await gate.decide(acpGateRequest('OpenCode', { kind: 'read', title: 'Read', locations: [{ path: '/w/src/a.ts' }] }))).toBe('accept');
    expect(asked).toBe(0);
    expect(await gate.decide(claudeGateRequest('Read', { file_path: '/w/.env' }))).toBe('decline');
    expect(asked).toBe(1);

    let auto = false;
    const autoGate = new ToolGate('assisted_execution', approver, ids, { autoApprove: () => auto });
    auto = true;
    expect(await autoGate.decide(claudeGateRequest('Read', { file_path: '/w/.env' }))).toBe('accept');
    expect(asked).toBe(1);
  });

  it('reads the auto-approve preference on every tool decision', async () => {
    let auto = false;
    let asked = 0;
    const gate = new ToolGate('assisted_execution', async () => { asked += 1; return 'accept' as const; }, { taskId: 't', stepId: 's' }, { autoApprove: () => auto });
    const command = { kind: 'command' as const, summary: 'run ls', detail: 'ls' };
    expect(await gate.decide(command)).toBe('accept');
    expect(asked).toBe(1);
    auto = true;
    expect(await gate.decide(command)).toBe('accept');
    expect(asked).toBe(1);
    auto = false;
    expect(await gate.decide(command)).toBe('accept');
    expect(asked).toBe(2);
  });

  it('stops asking in a read-only run when auto-approve is on', async () => {
    let asked = 0;
    const gate = new ToolGate('read_only', async () => { asked += 1; return 'decline' as const; },
      { taskId: 't', stepId: 's' }, { autoApprove: () => true });
    expect(await gate.decide({ kind: 'command', summary: 'run ls', detail: 'ls' })).toBe('accept');
    expect(await gate.decide({ kind: 'file_change', summary: 'edit a.ts', detail: 'a.ts' })).toBe('accept');
    expect(asked).toBe(0);
  });

  it('asks about commands in plan mode but still declines file changes', async () => {
    const asked: string[] = [];
    const approver = async () => { asked.push('x'); return 'accept' as const; };
    const gate = new ToolGate('read_only', approver, { taskId: 't', stepId: 'plan' }, { approveCommands: true });
    expect(await gate.decide({ kind: 'file_change', summary: 'edit a.ts' })).toBe('decline');
    expect(asked).toHaveLength(0);
    expect(await gate.decide({ kind: 'command', summary: 'run ls', detail: 'ls' })).toBe('accept');
    expect(asked).toHaveLength(1);
  });
});
