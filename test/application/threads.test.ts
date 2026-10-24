import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '@shared/domain';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { PermissionService } from '@main/domain/permission-service';
import { AuditLog } from '@main/domain/audit-log';
import { Registry } from '@main/registry/registry';
import { CliRegistrar } from '@main/catalog/registrar';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import { Orchestrator, TaskValidationError } from '@main/orchestrator/orchestrator';
import { TaskRunner } from '@main/orchestrator/task-runner';
import { TaskQueries } from '@main/orchestrator/task-queries';
import { evidenceEvaluator } from '@main/orchestrator/evidence-evaluator';
import { RecordingTaskEventEmitter } from '@main/orchestrator/event-emitter';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { replyFor, resumeTargetFor, threadHistory } from '@main/orchestrator/thread-context';
import { buildObjectiveLaunch } from '@main/adapters/objective-cli-adapter';

// A Codex-protocol fixture: prints a thread.started id, then a reply that
// reports whether it was resumed and how many earlier turns it received.
const CODEX_FIXTURE = `#!${process.execPath}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
  const body=JSON.parse(input.split('\\n').slice(1).join('\\n'));
  const i=process.argv.indexOf('resume');
  const resumed=i>=0?process.argv[process.argv.length-2]:'none';
  console.log(JSON.stringify({type:'thread.started',thread_id:'0b9c3d1e-7a2f-4c1b-9e8d-123456789abc'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Reply to '+body.objective+' | resumed='+resumed+' | history='+((body.conversation||[]).length)}}));
});
`;
// A plain-text fixture registered as claude-code: echoes the turn count.
const TEXT_FIXTURE = `#!${process.execPath}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
  const body=JSON.parse(input.split('\\n').slice(1).join('\\n'));
  console.log('Text reply to '+body.objective+' with '+((body.conversation||[]).length)+' earlier turns: '+((body.conversation||[]).map(t=>t.reply).join(' / ')));
});
`;

let root: string | undefined;
let store: SqliteStore | undefined;
afterEach(() => { store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

async function setup() {
  root = mkdtempSync(join(tmpdir(), 'conductor-threads-'));
  const codex = join(root, 'codex-fixture');
  const text = join(root, 'text-fixture');
  writeFileSync(codex, CODEX_FIXTURE, { mode: 0o755 });
  writeFileSync(text, TEXT_FIXTURE, { mode: 0o755 });
  store = new SqliteStore(':memory:');
  await store.migrate();
  const s = store;
  const workspaces = new WorkspaceService(s);
  const workspace = workspaces.create({ name: 'Threads', rootPath: root });
  const other = workspaces.create({ name: 'Other', rootPath: tmpdir() });
  const audit = new AuditLog(s);
  const permissions = new PermissionService(s, audit);
  const registry = new Registry();
  const registrar = new CliRegistrar(registry);
  registrar.ensureRegistered({ id: 'codex', displayName: 'Codex fixture', candidateBinaryNames: [codex], installMethod: { kind: 'unconfigured' } }, codex);
  registrar.ensureRegistered({ id: 'claude-code', displayName: 'Text fixture', candidateBinaryNames: [text], installMethod: { kind: 'unconfigured' } }, text);
  permissions.grant({ subject: { type: 'agent', id: 'orchestrator' }, profile: 'trusted_automation' });
  const machine = new TaskStateMachine(s, audit);
  const canceller = new TaskCanceller(s, machine, registry, audit);
  const storage = new DiskManagedStorage(join(root, 'blobs'));
  const emitter = new RecordingTaskEventEmitter();
  const rootPath = root;
  const orchestrator = new Orchestrator(s, machine, workspaces, canceller, audit, {
    registry, permissions, storage, emitter, maxStepRetries: 0, criterionEvaluator: evidenceEvaluator(s),
    executionInput: (task: Task, step) => {
      const conversation = threadHistory(s, task);
      const resume = resumeTargetFor(s, task, step.requiredCapability);
      return { objective: task.objective, rootPath, mode: 'trusted_automation', ...(conversation.length ? { conversation } : {}), ...(resume ? { resume } : {}) };
    },
  });
  const runner = new TaskRunner({ store: s, orchestrator, stateMachine: machine, permissions, registry, audit, emitter });
  return { s, runner, machine, workspace, other, queries: new TaskQueries(s, orchestrator, permissions, storage) };
}

describe('conversation threads', () => {
  it('continues a Codex thread by resuming the provider session', async () => {
    const { s, runner, machine, workspace, queries } = await setup();
    const first = await runner.create({ workspaceId: workspace.id, objective: 'first question', agentId: 'codex' });
    await runner.waitForIdle(first.id);
    expect(machine.getTask(first.id)?.state).toBe('COMPLETED');
    expect(machine.getTask(first.id)?.threadId).toBe(first.id);
    expect(replyFor(s, first.id)).toBe('Reply to first question | resumed=none | history=0');

    const second = await runner.create({ workspaceId: workspace.id, objective: 'follow up', parentTaskId: first.id });
    await runner.waitForIdle(second.id);
    const done = machine.getTask(second.id)!;
    expect(done.state).toBe('COMPLETED');
    expect(done.threadId).toBe(first.id);
    expect(done.parentTaskId).toBe(first.id);
    // Pinned to the same agent, resumed with the recorded thread id, and the
    // resumed session is not re-sent the earlier turns.
    expect(replyFor(s, second.id)).toBe('Reply to follow up | resumed=0b9c3d1e-7a2f-4c1b-9e8d-123456789abc | history=0');
    expect(queries.thread(first.id).map((t) => t.id)).toEqual([first.id, second.id]);
  });

  it('passes earlier turns as reference when another agent continues the thread', async () => {
    const { s, runner, machine, workspace } = await setup();
    const first = await runner.create({ workspaceId: workspace.id, objective: 'plan the launch', agentId: 'codex' });
    await runner.waitForIdle(first.id);
    const second = await runner.create({ workspaceId: workspace.id, objective: 'summarize it', parentTaskId: first.id, agentId: 'claude-code' });
    await runner.waitForIdle(second.id);
    expect(machine.getTask(second.id)?.state).toBe('COMPLETED');
    expect(replyFor(s, second.id)).toBe('Text reply to summarize it with 1 earlier turns: Reply to plan the launch | resumed=none | history=0');
  });

  it('rejects a parent from another project and an unavailable agent', async () => {
    const { runner, workspace, other } = await setup();
    const first = await runner.create({ workspaceId: workspace.id, objective: 'hello', agentId: 'codex' });
    await runner.waitForIdle(first.id);
    await expect(runner.create({ workspaceId: other.id, objective: 'cross', parentTaskId: first.id })).rejects.toBeInstanceOf(TaskValidationError);
    await expect(runner.create({ workspaceId: workspace.id, objective: 'nope', agentId: 'missing-agent' })).rejects.toThrow(/not available/);
  });
});

describe('codex launch arguments', () => {
  it('resumes with the sandbox pinned and never bypasses approvals', () => {
    const launch = buildObjectiveLaunch('codex', { objective: 'next', rootPath: '/tmp/w', mode: 'read_only', resume: { adapterId: 'codex', sessionId: '0b9c3d1e-7a2f-4c1b-9e8d-123456789abc' } });
    expect(launch.args).toEqual(['exec', '--sandbox', 'read-only', '--cd', '/tmp/w', 'resume', '--skip-git-repo-check', '--json', '-c', 'sandbox_mode="read-only"', '0b9c3d1e-7a2f-4c1b-9e8d-123456789abc', '-']);
    expect(launch.args!.join(' ')).not.toMatch(/dangerously|bypass/);
  });

  it('passes a configured model to Codex (local and remote) and Claude Code, rejecting unsafe names', () => {
    expect(buildObjectiveLaunch('codex', { objective: 'x', rootPath: '/w', models: { codex: 'gpt-5.6-sol' } }).args).toContain('gpt-5.6-sol');
    expect(buildObjectiveLaunch('remote:abc', { objective: 'x', rootPath: '/w', models: { codex: 'gpt-5.6-sol' } }).args!.slice(-4)).toEqual(['--json', '-m', 'gpt-5.6-sol', '-']);
    expect(buildObjectiveLaunch('claude-code', { objective: 'x', rootPath: '/w', models: { 'claude-code': 'sonnet' } }).args!.slice(-2)).toEqual(['--model', 'sonnet']);
    expect(buildObjectiveLaunch('codex', { objective: 'x', rootPath: '/w', models: { codex: 'm; rm -rf /' } }).args).not.toContain('-m');
  });

  it('ignores malformed session ids and passes approved MCP servers as config', () => {
    const launch = buildObjectiveLaunch('codex', {
      objective: 'x', rootPath: '/tmp/w', mode: 'assisted_execution', resume: { adapterId: 'codex', sessionId: 'bad id; rm -rf /' },
      mcpServers: [{ key: 'notes_1', command: 'npx', args: ['-y', 'server "quoted"'] }, { key: 'Bad-Key', url: 'https://x' }],
    });
    expect(launch.args).not.toContain('resume');
    expect(launch.args).toContain('mcp_servers.notes_1.command="npx"');
    expect(launch.args).toContain('mcp_servers.notes_1.args=["-y","server \\"quoted\\""]');
    expect(launch.args!.join(' ')).not.toContain('Bad-Key');
  });
});
