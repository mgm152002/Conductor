import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxManager, SANDBOX_IMAGE, parseMemUsage, type DockerRunner } from '@main/sandbox/sandbox-manager';
import { SandboxAgentService } from '@main/sandbox/sandbox-agents';
import { SandboxGateway } from '@main/sandbox/sandbox-gateway';
import { SqliteStore } from '@main/db/store';

// The container lifecycle with a fake Docker CLI, and the agent service that
// ties a thread to an agent. No Docker or network is used.

let dockerCalls: string[][];
let memTotal: number;
let usedBytes: number;
let nextPort: number;

const docker: DockerRunner = async (args) => {
  dockerCalls.push(args);
  const joined = args.join(' ');
  if (joined.startsWith('info --format {{.MemTotal}}')) return `${memTotal}\n`;
  if (joined.startsWith('info')) return '27.5.1\n';
  if (args[0] === 'stats') return `${(usedBytes / 1024 ** 2).toFixed(0)}MiB / ${(memTotal / 1024 ** 3).toFixed(1)}GiB\n`;
  if (joined.startsWith('image inspect')) return 'sha256:abc\n';
  if (args[0] === 'run') return 'container-id\n';
  if (args[0] === 'port') return `127.0.0.1:${nextPort++}\n`;
  if (joined.startsWith('ps -aq')) return 'old1\nold2\n';
  return '';
};

const manager = (options: { idleStopMs?: number } = {}) => new SandboxManager({
  docker,
  waitReady: async () => {},
  ...(options.idleStopMs !== undefined ? { idleStopMs: options.idleStopMs } : {}),
});

beforeEach(() => {
  dockerCalls = [];
  memTotal = 8 * 1024 ** 3;
  usedBytes = 0;
  nextPort = 50_000;
});

describe('SandboxManager', () => {
  it('starts a locked-down container bound to loopback with a random key', async () => {
    const endpoint = await manager().acquire({ taskId: 'task-1', agentId: 'a', agentName: 'Researcher' });
    const run = dockerCalls.find((args) => args[0] === 'run')!;
    expect(run).toContain('--security-opt');
    expect(run).toContain('seccomp=unconfined');
    expect(run).toContain('127.0.0.1::8080');
    expect(run.at(-1)).toBe(SANDBOX_IMAGE);
    const keyArg = run[run.indexOf('-e') + 1]!;
    expect(keyArg).toMatch(/^SANDBOX_API_KEY=[0-9a-f]{48}$/);
    expect(endpoint).toEqual({ baseUrl: 'http://127.0.0.1:50000', apiKey: keyArg.split('=')[1] });
  });

  it('reuses the thread’s sandbox for follow-ups', async () => {
    const subject = manager();
    const first = await subject.acquire({ taskId: 'task-1', agentId: 'a', agentName: 'A' });
    const second = await subject.acquire({ taskId: 'task-2', agentId: 'a', agentName: 'A' });
    expect(second).toEqual(first);
    expect(dockerCalls.filter((args) => args[0] === 'run')).toHaveLength(1);
  });

  it('runs as many sandboxes as Docker’s memory allows, then warns instead of starting another', async () => {
    memTotal = 8 * 1024 ** 3;
    usedBytes = 1 * 1024 ** 3;
    const subject = manager();
    await subject.acquire({ taskId: 'task-1', agentId: 'one', agentName: 'Researcher' });
    usedBytes = 3 * 1024 ** 3;
    await subject.acquire({ taskId: 'task-2', agentId: 'two', agentName: 'Tester' });
    usedBytes = 7.2 * 1024 ** 3;
    await expect(subject.acquire({ taskId: 'task-3', agentId: 'three', agentName: 'Analyst' })).rejects.toThrow(/Can’t start another agent sandbox.*Running now: Researcher, Tester/);
    expect((await subject.status()).running.map((run) => run.agentId)).toEqual(['one', 'two']);
  });

  it('stops an idle sandbox to make room before warning', async () => {
    memTotal = 4 * 1024 ** 3;
    usedBytes = 1 * 1024 ** 3;
    let stopped = false;
    // Removing the idle container frees its memory, as Docker would report.
    const subject = new SandboxManager({
      docker: async (args) => { if (args[0] === 'rm') { stopped = true; usedBytes = 1 * 1024 ** 3; } return docker(args); },
      waitReady: async () => {},
    });
    await subject.acquire({ taskId: 'task-1', agentId: 'one', agentName: 'A' });
    subject.release('one', 'task-1');
    usedBytes = 3.5 * 1024 ** 3;
    await subject.acquire({ taskId: 'task-2', agentId: 'two', agentName: 'B' });
    expect(stopped).toBe(true);
    expect((await subject.status()).running.map((run) => run.agentId)).toEqual(['two']);
  });

  it('stops a sandbox after it sits idle', async () => {
    const subject = manager({ idleStopMs: 10 });
    await subject.acquire({ taskId: 'task-1', agentId: 'a', agentName: 'A' });
    subject.release('a', 'task-1');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(subject.endpoint('a')).toBeUndefined();
  });

  it('reads Docker’s memory figures', () => {
    expect(parseMemUsage('512MiB / 3.8GiB')).toBe(512 * 1024 ** 2);
    expect(parseMemUsage('1.5GiB / 3.8GiB')).toBe(1.5 * 1024 ** 3);
  });

  it('removes containers left over from an earlier run', async () => {
    await manager().cleanupOrphans();
    expect(dockerCalls.at(-1)).toEqual(['rm', '-f', 'old1', 'old2']);
  });
});

describe('SandboxAgentService', () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sandbox-agents-'));
    store = new SqliteStore(join(dir, 'app.db'));
    await store.migrate();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const service = (available: string[] = ['claude-code', 'codex']) => new SandboxAgentService({
    store, manager: manager(), gateway: new SandboxGateway(),
    approver: async () => 'accept', autoApprove: () => false,
    cliAvailable: (id) => available.includes(id),
    log: () => {},
    agentWorkspace: () => 'agent-space',
  });
  const input = {
    name: 'Researcher', description: 'Finds things', instructions: 'Cite sources.',
    clis: ['opencode', 'claude-code', 'codex'], tools: ['browser' as const], approval: 'risky' as const, color: '#4a6fe8',
  };

  it('validates and stores agents', () => {
    const subject = service();
    expect(() => subject.create({ ...input, clis: [] })).toThrow(/CLI/);
    expect(() => subject.create({ ...input, tools: [] })).toThrow(/tool/);
    const agent = subject.create(input);
    expect(subject.list()).toEqual([agent]);
    expect(subject.update(agent.id, { ...input, name: 'Scout' }).name).toBe('Scout');
    subject.remove(agent.id);
    expect(subject.list()).toEqual([]);
  });

  it('starts on the first available CLI and falls back in the agent’s own order', () => {
    const subject = service(['claude-code', 'codex']);
    const agent = subject.create(input);
    expect(subject.startingCli(agent.id)).toBe('claude-code');
    expect(subject.startingCli(agent.id, 'codex')).toBe('codex');
    expect(() => subject.startingCli(agent.id, 'opencode')).toThrow(/available/);
    expect(() => subject.startingCli(agent.id, 'kiro')).toThrow(/isn’t set up/);
    subject.bindThread('thread-1', agent.id);
    expect(subject.fallbackOrder({ id: 'task-2', threadId: 'thread-1' })).toEqual(['opencode', 'claude-code', 'codex']);
    expect(subject.fallbackOrder({ id: 'other' })).toBeUndefined();
    expect(subject.threadAgents()).toEqual({ 'thread-1': agent.id });
  });

  it('sends a group message to each member in its own thread, and continues it next time', async () => {
    const subject = service(['claude-code', 'codex']);
    const a = subject.create({ ...input, name: 'Researcher' });
    const b = subject.create({ ...input, name: 'Tester' });
    const group = subject.createGroup('', [a.id, b.id]);
    expect(group.name).toBe('Researcher, Tester');
    const created: Array<{ objective: string; parentTaskId?: string; agentId?: string }> = [];
    let n = 0;
    subject.setTaskCreator(async (request) => {
      created.push(request);
      n += 1;
      const task = { id: `00000000-0000-4000-8000-00000000000${n}`, threadId: request.parentTaskId === undefined ? undefined : 'x' } as never as import('@shared/domain').Task;
      request.onCreated?.(task);
      return task;
    });
    // Reply tasks reference the tasks table; skip FK checks for this fake runner.
    store.db.pragma('foreign_keys = OFF');
    const first = await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'Plan a launch' });
    expect(Object.keys(first.replies).sort()).toEqual([a.id, b.id].sort());
    expect(created[0]!.objective).toContain('Group chat');
    expect(created[0]!.objective).toContain('Plan a launch');
    expect(created[0]!.agentId).toBe('claude-code');
    expect(Object.keys(subject.groupThreadMap())).toHaveLength(2);
    await expect(subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'x', agentIds: ['00000000-0000-4000-8000-000000000099'] })).rejects.toThrow(/Mention/);
    expect(subject.groupMessages(group.id)).toHaveLength(1);
  });

  it('keeps a model per CLI and drops choices for CLIs the agent does not use', () => {
    const subject = service();
    const agent = subject.create({ ...input, models: { codex: { model: 'gpt-5', effort: 'high' }, kiro: { model: 'x' }, 'claude-code': { model: 'bad model!' } } });
    expect(agent.models).toEqual({ codex: { model: 'gpt-5', effort: 'high' } });
    subject.bindThread('thread-1', agent.id);
    expect(subject.choiceFor({ id: 't', threadId: 'thread-1' }, 'codex')).toEqual({ model: 'gpt-5', effort: 'high' });
    expect(subject.choiceFor({ id: 't', threadId: 'thread-1' }, 'opencode')).toBeUndefined();
    expect(subject.update(agent.id, { ...input, models: {} }).models).toEqual({});
  });

  it('gives a run the sandbox gateway and the agent’s instructions', async () => {
    const subject = service();
    const agent = subject.create(input);
    subject.bindThread('thread-1', agent.id);
    const run = await subject.prepareStep({ id: 'thread-1', threadId: 'thread-1' } as never, 'step-1', 'assisted_execution');
    expect(run?.server.key).toBe('sandbox');
    expect(run?.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/g\/[0-9a-f]{48}\/mcp$/);
    expect(run?.guidance).toContain('"Researcher"');
    expect(run?.guidance).toContain('Cite sources.');
    expect(run?.guidance).toContain('web browser');
    expect(await subject.prepareStep({ id: 'plain' } as never, 'step-1', 'assisted_execution')).toBeUndefined();
    subject.release({ id: 'thread-1', threadId: 'thread-1' });
  });
});

describe('hidden agent workspace', () => {
  it('is kept out of the project list but still usable for tasks', async () => {
    const { WorkspaceService } = await import('@main/domain/workspace-service');
    const dir = mkdtempSync(join(tmpdir(), 'agent-ws-'));
    const store = new SqliteStore(join(dir, 'app.db'));
    await store.migrate();
    const workspaces = new WorkspaceService(store);
    const id = '00000000-0000-4000-8000-0000a6e17000';
    const created = workspaces.ensureHidden(id, 'Agents', join(dir, 'agent-space'));
    expect(created.id).toBe(id);
    expect(workspaces.ensureHidden(id, 'Agents', join(dir, 'agent-space')).id).toBe(id);
    expect(workspaces.list().map((w) => w.id)).not.toContain(id);
    expect(workspaces.get(id)?.rootPath).toBe(join(dir, 'agent-space'));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
