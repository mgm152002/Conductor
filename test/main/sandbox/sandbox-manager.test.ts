import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxManager, SANDBOX_IMAGE, agentVolume, browserVolume, parseMemUsage, type DockerRunner } from '@main/sandbox/sandbox-manager';
import { SandboxAgentService, groupSandboxKey } from '@main/sandbox/sandbox-agents';
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
    const run = dockerCalls.find((args) => args[0] === 'run' && args.includes('-d'))!;
    expect(run).toContain('--security-opt');
    expect(run).toContain('seccomp=unconfined');
    expect(run).toContain('127.0.0.1::8080');
    expect(run.at(-1)).toBe(SANDBOX_IMAGE);
    const keyArg = run[run.indexOf('-e') + 1]!;
    expect(keyArg).toMatch(/^SANDBOX_API_KEY=[0-9a-f]{48}$/);
    expect(endpoint).toEqual({ baseUrl: 'http://127.0.0.1:50000', apiKey: keyArg.split('=')[1] });
  });

  it('mounts the agent’s own volume and the shared one, and keeps them when the sandbox stops', async () => {
    const subject = manager();
    await subject.acquire({ taskId: 'task-1', agentId: 'agent-1', agentName: 'A' });
    await subject.acquire({ taskId: 'task-2', agentId: 'agent-2', agentName: 'B' });
    const runs = dockerCalls.filter((args) => args[0] === 'run' && args.includes('-d'));
    const mounts = (args: string[]): string[] => args.flatMap((arg, index) => (arg === '-v' ? [args[index + 1]!] : []));
    expect(mounts(runs[0]!)).toEqual(['conductor-sandbox-agent-agent-1:/home/gem/workspace', 'conductor-sandbox-shared:/home/gem/shared', 'conductor-sandbox-browser-agent-1:/home/gem/.config/browser']);
    expect(mounts(runs[1]!)).toEqual(['conductor-sandbox-agent-agent-2:/home/gem/workspace', 'conductor-sandbox-shared:/home/gem/shared', 'conductor-sandbox-browser-agent-2:/home/gem/.config/browser']);
    expect(dockerCalls.some((args) => args[0] === 'exec' && args.at(-1)!.includes('chown gem:gem /home/gem/workspace /home/gem/shared'))).toBe(true);

    await subject.stop('agent-1');
    await subject.cleanupOrphans();
    expect(dockerCalls.some((args) => args[0] === 'volume')).toBe(false);
    expect(dockerCalls.filter((args) => args[0] === 'rm').every((args) => !args.includes('-v'))).toBe(true);

    // Restarting the agent mounts the same volume again.
    await subject.acquire({ taskId: 'task-3', agentId: 'agent-1', agentName: 'A' });
    expect(mounts(dockerCalls.filter((args) => args[0] === 'run' && args.includes('-d'))[2]!)[0]).toBe('conductor-sandbox-agent-agent-1:/home/gem/workspace');
  });

  it('deletes only the agent’s own volume when the agent is deleted', async () => {
    const subject = manager();
    await subject.acquire({ taskId: 'task-1', agentId: 'agent-1', agentName: 'A' });
    await subject.forget('agent-1');
    expect(dockerCalls.filter((args) => args[0] === 'volume')).toEqual([['volume', 'rm', '-f', 'conductor-sandbox-browser-agent-1'], ['volume', 'rm', '-f', 'conductor-sandbox-agent-agent-1']]);
    expect(agentVolume('a/b c:d')).toBe('conductor-sandbox-agent-abcd');
  });

  it('keeps a sandbox’s browser logins in a volume of its own and lets them be cleared', async () => {
    const subject = manager();
    await subject.acquire({ taskId: 'task-1', agentId: 'agent-1', agentName: 'A' });
    // Before the browser starts: stale lock files go, and cookies are allowed to outlive the browser.
    const prep = dockerCalls.find((args) => args[0] === 'run' && !args.includes('-d'))!;
    expect(prep.join(' ')).toContain('conductor-sandbox-browser-agent-1:/b');
    expect(prep.at(-1)).toContain('rm -f /b/SingletonLock');
    expect(prep.at(-1)).toContain('chown 1000:1000 /b');
    const sandbox = dockerCalls.find((args) => args[0] === 'run' && args.includes('-d'))!;
    // ~/.config is an owned tmpfs so the browser volume under it doesn't leave it root-owned.
    expect(sandbox[sandbox.indexOf('--tmpfs') + 1]).toMatch(/^\/home\/gem\/\.config:uid=1000,gid=1000/);
    expect(dockerCalls.indexOf(prep)).toBeLessThan(dockerCalls.findIndex((args) => args[0] === 'run' && args.includes('-d')));
    // Stopping asks the browser to close cleanly (so cookies are written) before removing the container.
    await subject.stop('agent-1');
    const closeAt = dockerCalls.findIndex((args) => args[0] === 'exec' && args.includes('node'));
    expect(closeAt).toBeGreaterThan(-1);
    expect(closeAt).toBeLessThan(dockerCalls.findIndex((args) => args[0] === 'rm' && args[1] === '-f' && args.length === 3 && args[2]!.startsWith('conductor-sbx-')));
    expect(dockerCalls.some((args) => args[0] === 'volume')).toBe(false);
    // Clearing logins deletes only that profile volume.
    await subject.clearBrowser('agent-1');
    expect(dockerCalls.filter((args) => args[0] === 'volume')).toEqual([['volume', 'rm', '-f', 'conductor-sandbox-browser-agent-1']]);
    expect(browserVolume('a/b c:d')).toBe('conductor-sandbox-browser-abcd');
  });

  it('mounts a browser policy that lets cookies outlive the browser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const file = join(dir, 'sub', 'policy.json');
    try {
      await new SandboxManager({ docker, waitReady: async () => {}, browserPolicyFile: file }).acquire({ taskId: 't', agentId: 'a', agentName: 'A' });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ DefaultCookiesSetting: 1 });
      const sandbox = dockerCalls.find((args) => args[0] === 'run' && args.includes('-d'))!;
      expect(sandbox).toContain(`${file}:/etc/browser/policies/managed/conductor.json:ro`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses the thread’s sandbox for follow-ups', async () => {
    const subject = manager();
    const first = await subject.acquire({ taskId: 'task-1', agentId: 'a', agentName: 'A' });
    const second = await subject.acquire({ taskId: 'task-2', agentId: 'a', agentName: 'A' });
    expect(second).toEqual(first);
    expect(dockerCalls.filter((args) => args[0] === 'run' && args.includes('-d'))).toHaveLength(1);
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

  it('works a group’s sandbox in the shared volume and never deletes it', async () => {
    const subject = manager();
    await subject.acquire({ taskId: 'task-1', agentId: 'group-g1', agentName: 'Group' });
    const mounts = dockerCalls.find((args) => args[0] === 'run' && args.includes('-d'))!.flatMap((arg, index, all) => (arg === '-v' ? [all[index + 1]!] : []));
    expect(mounts.slice(0, 3)).toEqual(['conductor-sandbox-shared:/home/gem/workspace', 'conductor-sandbox-shared:/home/gem/shared', 'conductor-sandbox-browser-group-g1:/home/gem/.config/browser']);
    await subject.forget('group-g1');
    // Only the group's own browser profile goes; the shared files stay.
    expect(dockerCalls.filter((args) => args[0] === 'volume')).toEqual([['volume', 'rm', '-f', 'conductor-sandbox-browser-group-g1']]);
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
    deliverFile: () => undefined,
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

  it('keeps an agent icon, and drops anything that is not a small image', () => {
    const subject = service();
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    const agent = subject.create({ ...input, icon });
    expect(agent.icon).toBe(icon);
    expect(subject.update(agent.id, { ...input, icon: 'javascript:alert(1)' }).icon).toBe('');
    expect(subject.update(agent.id, { ...input, icon }).icon).toBe(icon);
    expect(subject.update(agent.id, input).icon).toBe('');
    expect(subject.create(input).icon).toBe('');
  });

  it('tells an agent to read the shared notebook after a restart or a change of CLI', async () => {
    const subject = service();
    const agent = subject.create(input);
    store.db.pragma('foreign_keys = OFF');
    const now = new Date().toISOString();
    const addTurn = (id: string, adapter: string): { id: string; threadId: string; stepId: string } => {
      store.db.prepare("INSERT INTO tasks (id, workspace_id, objective, state, thread_id, created_at, updated_at) VALUES (?, 'w', 'x', 'COMPLETED', 't1', ?, ?)").run(id, now, now);
      store.db.prepare("INSERT INTO task_steps (id, task_id, ordinal, description, status, assigned_adapter_id) VALUES (?, ?, 0, 'x', 'succeeded', ?)").run(`${id}-step`, id, adapter);
      return { id, threadId: 't1', stepId: `${id}-step` };
    };
    subject.bindThread('t1', agent.id);
    const first = addTurn('a', 'claude-code');
    const guidance = async (turn: { id: string; threadId: string; stepId: string }): Promise<string> => {
      const run = await subject.prepareStep({ id: turn.id, threadId: turn.threadId } as never, turn.stepId, 'read_only');
      subject.release({ id: turn.id, threadId: turn.threadId });
      return run!.guidance;
    };
    // No sandbox is running, so it is a (re)start.
    expect(await guidance(first)).toMatch(/was just \(re\)started, so FIRST read \/home\/gem\/shared\/memory\.md/);
    // Same CLI again, but still a fresh sandbox: also a restart.
    const second = addTurn('b', 'claude-code');
    expect(await guidance(second)).toContain('FIRST read');
    // Another CLI takes over.
    const third = addTurn('c', 'codex');
    expect(await guidance(third)).toContain('A different CLI or model has just taken over');
    // Every run is told to keep the notebook.
    expect(await guidance(third)).toContain('Keep a shared notebook at /home/gem/shared/memory.md');
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

  it('steers or queues a group message for a member who is still working', async () => {
    const subject = service();
    const a = subject.create({ ...input, name: 'Researcher' });
    const b = subject.create({ ...input, name: 'Tester' });
    const group = subject.createGroup('', [a.id, b.id]);
    store.db.pragma('foreign_keys = OFF');
    const now = new Date().toISOString();
    const addTask = (id: string, state: string): void => {
      store.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, acceptance_criteria, state, thread_id, created_at, updated_at) VALUES (?, 'w', 'o', '[]', ?, ?, ?, ?)`).run(id, state, id, now, now);
    };
    // Each member already has a thread: the Researcher is mid-run, the Tester is done.
    addTask('task-a', 'RUNNING');
    addTask('task-b', 'COMPLETED');
    store.db.prepare('UPDATE agent_group_members SET thread_id = ? WHERE group_id = ? AND agent_id = ?').run('task-a', group.id, a.id);
    store.db.prepare('UPDATE agent_group_members SET thread_id = ? WHERE group_id = ? AND agent_id = ?').run('task-b', group.id, b.id);
    const created: Array<{ parentTaskId?: string }> = [];
    subject.setTaskCreator(async (request) => {
      created.push(request);
      const task = { id: 'task-b2', threadId: 'task-b' } as never as import('@shared/domain').Task;
      request.onCreated?.(task);
      return task;
    });
    const held: Array<{ taskId: string; objective: string; mode: string }> = [];
    subject.setMessageQueue(async (request) => {
      held.push(request);
      store.db.prepare(`INSERT INTO task_message_queue (id, anchor_task_id, thread_id, workspace_id, objective, mode, status, created_at, updated_at) VALUES ('q1', ?, ?, 'w', ?, ?, 'pending', ?, ?)`)
        .run(request.taskId, request.taskId, request.objective, request.mode, now, now);
      return { id: 'q1', anchorTaskId: request.taskId, threadId: request.taskId, objective: request.objective, mode: request.mode, status: 'pending', createdAt: now };
    });

    const sent = await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'Change of plan', mode: 'steer' });
    // The idle member starts at once; the busy one is steered, not started alongside its own run.
    expect(created.map((request) => request.parentTaskId)).toEqual(['task-b']);
    expect(held).toEqual([expect.objectContaining({ taskId: 'task-a', mode: 'steer' })]);
    expect(held[0]!.objective).toContain('Change of plan');
    expect(sent.replies).toEqual({ [b.id]: 'task-b2' });
    expect(sent.waiting).toEqual({ [a.id]: { queueId: 'q1', mode: 'steer' } });

    // Once the held message is dispatched, it is that member's reply.
    store.db.prepare("UPDATE task_message_queue SET status = 'dispatched', dispatched_task_id = 'task-a2' WHERE id = 'q1'").run();
    const after = subject.groupMessages(group.id)[0]!;
    expect(after.replies).toEqual({ [b.id]: 'task-b2', [a.id]: 'task-a2' });
    expect(after.waiting).toBeUndefined();
  });

  it('runs a group message on the chosen CLI for members that have it, and leaves the others on their own', async () => {
    const subject = service(['claude-code', 'codex', 'kiro']);
    const a = subject.create({ ...input, name: 'Researcher', clis: ['claude-code', 'codex'] });
    const b = subject.create({ ...input, name: 'Tester', clis: ['kiro', 'claude-code'] });
    const group = subject.createGroup('', [a.id, b.id]);
    const created: Array<{ agentId?: string; runOptions?: unknown; parentTaskId?: string }> = [];
    subject.setTaskCreator(async (request) => {
      created.push(request);
      const task = { id: `00000000-0000-4000-8000-00000000000${created.length}` } as never as import('@shared/domain').Task;
      request.onCreated?.(task);
      return task;
    });
    store.db.pragma('foreign_keys = OFF');
    // Codex belongs to the Researcher only.
    await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'Go', agentId: 'codex', runOptions: { main: { model: 'gpt-x' } } });
    expect(created.find((request) => request.agentId === 'codex')?.runOptions).toEqual({ main: { model: 'gpt-x' } });
    const other = created.find((request) => request.agentId !== 'codex')!;
    expect(other.agentId).toBe('kiro'); // the Tester's own first CLI
    expect(other.runOptions).toBeUndefined();
    // Auto leaves everyone on their own first CLI.
    created.length = 0;
    await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'Again' });
    expect(created.map((request) => request.agentId).sort()).toEqual(['claude-code', 'kiro']);
    expect(created.every((request) => request.runOptions === undefined)).toBe(true);
  });

  it('deletes a group’s member threads with the group, and purges threads left over from a group already deleted', async () => {
    const subject = service();
    const a = subject.create({ ...input, name: 'Researcher' });
    const b = subject.create({ ...input, name: 'Tester' });
    const group = subject.createGroup('', [a.id, b.id]);
    store.db.pragma('foreign_keys = OFF');
    const now = new Date().toISOString();
    const addTask = (id: string, objective: string): void => {
      store.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, acceptance_criteria, state, thread_id, created_at, updated_at) VALUES (?, 'w', ?, '[]', 'COMPLETED', ?, ?, ?)`).run(id, objective, id, now, now);
    };
    addTask('own-chat', 'my own question');
    addTask('group-thread', '[Group chat “G” — you are Researcher]\n\nMessage:\nhi');
    addTask('left-over', '[Group chat “Old” — you are Tester]\n\nMessage:\nhi');
    subject.bindThread('own-chat', a.id);
    subject.bindThread('group-thread', a.id);
    subject.bindThread('left-over', b.id);
    store.db.prepare('UPDATE agent_group_members SET thread_id = ? WHERE group_id = ? AND agent_id = ?').run('group-thread', group.id, a.id);
    const deleted: string[] = [];
    subject.setThreadDeleter(async (threadId) => { deleted.push(threadId); });

    // 'left-over' belongs to no group: it is purged. The live group's thread and the agent's own chat stay.
    expect(await subject.purgeOrphanGroupThreads()).toBe(1);
    expect(deleted).toEqual(['left-over']);
    expect(Object.keys(subject.threadAgents()).sort()).toEqual(['group-thread', 'own-chat']);

    await subject.removeGroup(group.id);
    expect(deleted).toEqual(['left-over', 'group-thread']);
    expect(Object.keys(subject.threadAgents())).toEqual(['own-chat']);
    expect(subject.listGroups()).toEqual([]);
  });

  describe('planning a group message', () => {
    const setup = (planReply: string | undefined | (() => never)) => {
      const subject = service(['claude-code', 'codex']);
      const researcher = subject.create({ ...input, name: 'Web researcher' });
      const tailor = subject.create({ ...input, name: 'Resume Tailor' });
      const group = subject.createGroup('Job hunt', [researcher.id, tailor.id]);
      store.db.pragma('foreign_keys = OFF');
      const created: Array<{ id: string; objective: string; agentId?: string }> = [];
      subject.setTaskCreator(async (request) => {
        const task = { id: `00000000-0000-4000-8000-0000000000${String(created.length + 10)}` } as never as import('@shared/domain').Task;
        created.push({ id: task.id, objective: request.objective, ...(request.agentId !== undefined ? { agentId: request.agentId } : {}) });
        request.onCreated?.(task);
        return task;
      });
      subject.setReplyReader((taskId) => (taskId === created[0]?.id ? 'SAS — Software Developer Intern, Cary NC, posted Nov 14.' : ''));
      subject.setGroupPlanner(async () => { if (typeof planReply === 'function') planReply(); return planReply as string | undefined; });
      return { subject, researcher, tailor, group, created };
    };
    const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(check()).toBe(true); };
    const dagReply = '```json\n' + JSON.stringify({ summary: 'Research, then tailor.', steps: [
      { agent: 'Web researcher', instruction: 'Find the newest SWE internship posted yesterday.', after: [] },
      { agent: 'Resume Tailor', instruction: 'Tailor the resume for that posting.', after: ['Web researcher'] },
    ] }) + '\n```';

    it('shows the message at once, then runs dependent parts in order in one shared sandbox', async () => {
      const { subject, researcher, tailor, group, created } = setup(dagReply);
      const sent = await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'find the newest swe internship and tailor my resume for it' });
      expect(sent.plan?.mode).toBe('planning');
      await until(() => created.length === 1);
      // Only the researcher starts; the tailor waits for its result.
      expect(created[0]!.objective).toContain('Your part:\nFind the newest SWE internship');
      expect(created[0]!.objective).toContain('SAME sandbox');
      const midway = subject.groupMessages(group.id)[0]!.plan!;
      expect(midway.mode).toBe('dag');
      expect(midway.steps.map((step) => [step.agentId, step.status, step.dependsOn])).toEqual([[researcher.id, 'running', []], [tailor.id, 'waiting', [0]]]);

      // Both parts use the group's one sandbox, not their agents' own.
      const firstTask = created[0]!.id;
      expect((subject as unknown as { sandboxScope(id: string): unknown }).sandboxScope(firstTask)).toEqual({ key: groupSandboxKey(group.id), name: 'Job hunt' });

      await subject.taskSettled({ id: firstTask, state: 'COMPLETED' });
      expect(created).toHaveLength(2);
      expect(created[1]!.objective).toContain('Web researcher finished and said:\nSAS — Software Developer Intern');
      expect(created[1]!.objective).toContain('Tailor the resume for that posting.');
      await subject.taskSettled({ id: created[1]!.id, state: 'COMPLETED' });
      expect(subject.groupMessages(group.id)[0]!.plan!.steps.map((step) => step.status)).toEqual(['done', 'done']);
    });

    it('settles a part whose task ended while nobody was listening, and goes on to the next', async () => {
      const { subject, group, created } = setup(dagReply);
      await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'x' });
      await until(() => created.length === 1);
      const now = new Date().toISOString();
      // The researcher's task is COMPLETED in the tasks table, but its part is still 'running'.
      store.db.prepare(`INSERT INTO tasks (id, workspace_id, objective, acceptance_criteria, state, thread_id, created_at, updated_at) VALUES (?, 'w', 'o', '[]', 'COMPLETED', ?, ?, ?)`).run(created[0]!.id, created[0]!.id, now, now);
      await subject.reconcileGroupSteps();
      expect(created).toHaveLength(2);
      expect(subject.groupMessages(group.id)[0]!.plan!.steps.map((step) => step.status)).toEqual(['done', 'running']);
      // Running it again changes nothing.
      await subject.reconcileGroupSteps();
      expect(created).toHaveLength(2);
    });

    it('skips the parts that need a result that never came', async () => {
      const { subject, group, created } = setup(dagReply);
      await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'x' });
      await until(() => created.length === 1);
      await subject.taskSettled({ id: created[0]!.id, state: 'FAILED' });
      expect(created).toHaveLength(1);
      const steps = subject.groupMessages(group.id)[0]!.plan!.steps;
      expect(steps.map((step) => step.status)).toEqual(['failed', 'skipped']);
      expect(steps[1]!.note).toMatch(/Web researcher did not finish/);
    });

    it('runs independent parts at once, each in its own sandbox', async () => {
      const { subject, group, created } = setup('```json\n{"steps":[{"agent":"Web researcher","instruction":"a"},{"agent":"Resume Tailor","instruction":"b"}]}\n```');
      await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'do your jobs' });
      await until(() => created.length === 2);
      expect(subject.groupMessages(group.id)[0]!.plan!.mode).toBe('parallel');
      expect((subject as unknown as { sandboxScope(id: string): unknown }).sandboxScope(created[0]!.id)).toBeUndefined();
    });

    it('falls back to everyone at once when the planner fails or answers nonsense', async () => {
      for (const reply of [undefined, 'no idea', (() => { throw new Error('offline'); }) as () => never]) {
        const { subject, group, created } = setup(reply);
        await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'hello' });
        await until(() => created.length === 2);
        const plan = subject.groupMessages(group.id)[0]!.plan!;
        expect(plan.mode).toBe('parallel');
        expect(created.every((task) => task.objective.includes('Message:\nhello'))).toBe(true);
        store.db.prepare('DELETE FROM agent_groups').run();
      }
    });

    it('does not plan for a single member', async () => {
      const { subject, researcher, group, created } = setup(dagReply);
      const sent = await subject.sendGroup({ groupId: group.id, workspaceId: 'w', text: 'just you', agentIds: [researcher.id] });
      expect(sent.plan?.mode).toBe('parallel');
      expect(created).toHaveLength(1);
    });
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
