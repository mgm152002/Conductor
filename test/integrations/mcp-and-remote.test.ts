import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { McpRegistry } from '@main/mcp/mcp-registry';
import { McpService } from '@main/mcp/mcp-service';
import { SdkMcpTransport, parseConfigFile, parseEndpoint, splitCommandLine } from '@main/mcp/sdk-transport';
import { SshRemoteTransport, assertSshHost, shellQuote } from '@main/adapters/ssh-transport';
import { RemoteHostService } from '@main/adapters/remote-hosts';
import { Registry } from '@main/registry/registry';

let dir: string;
let store: SqliteStore;
let audit: AuditLog;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-int-'));
  store = new SqliteStore(join(dir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const FIXTURE = resolve(__dirname, '../fixtures/mcp-echo-server.mjs');

describe('MCP over the official SDK', () => {
  it('keeps added servers stopped until approved, then lists and calls tools', async () => {
    const transport = new SdkMcpTransport([]);
    const registry = new McpRegistry(store, audit, { transport, accessControl: ({ caller }) => caller === 'user' });
    const mcp = new McpService(registry, transport);
    const added = mcp.add({ name: 'Echo', endpoint: `${shellQuote(process.execPath)} ${shellQuote(FIXTURE)}` });
    expect(added.trustStatus).toBe('untrusted');
    expect(added.enablement).toBe('disabled');
    // Not approved: health checks do not launch the command.
    expect((await registry.checkHealth(added.id)).health).toBe('unhealthy');
    expect((await mcp.invoke({ id: added.id, tool: 'echo', args: { text: 'hi' } })).ok).toBe(false);

    const approved = await mcp.approve(added.id);
    expect(approved.enablement).toBe('enabled');
    expect(approved.health).toBe('healthy');
    expect(approved.capabilities.map((c) => c.id).sort()).toEqual(['add', 'echo']);

    const result = await mcp.invoke({ id: added.id, tool: 'add', args: { a: 2, b: 3 } });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.ok ? result.output : null)).toContain('"text":"5"');
    expect(mcp.forAgents()).toEqual([{ key: added.id.replace(/-/g, '_'), command: process.execPath, args: [FIXTURE] }]);
    await mcp.disable(added.id);
    expect(mcp.forAgents()).toEqual([]);
    await mcp.stop();
  }, 30_000);

  it('rolls back to disabled when an approved server cannot start', async () => {
    const transport = new SdkMcpTransport([]);
    const registry = new McpRegistry(store, audit, { transport });
    const mcp = new McpService(registry, transport);
    const added = mcp.add({ name: 'Broken', endpoint: '/nonexistent/mcp-server-binary' });
    await expect(mcp.approve(added.id)).rejects.toThrow(/Could not start/);
    expect(registry.getOrThrow(added.id).enablement).toBe('disabled');
  }, 20_000);

  it('parses endpoints and other apps’ configs without launching anything', () => {
    expect(splitCommandLine(`npx -y "@scope/pkg" 'a b' c\\ d`)).toEqual(['npx', '-y', '@scope/pkg', 'a b', 'c d']);
    expect(parseEndpoint('https://mcp.example.com/mcp').kind).toBe('http');
    expect(() => parseEndpoint('http://example.com/mcp')).toThrow(/https/);
    expect(parseEndpoint('http://localhost:3000/mcp').kind).toBe('http');
    const json = parseConfigFile({ label: 'cursor' }, JSON.stringify({ mcpServers: {
      files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/My Notes'] },
      secret: { command: 'srv', env: { API_KEY: 'x' } },
      remote: { url: 'https://mcp.example.com/mcp' },
    } }));
    expect(json.map((e) => e.name)).toEqual(['files', 'remote']);
    expect(json[0]!.endpoint).toBe("npx -y @modelcontextprotocol/server-filesystem '/Users/me/My Notes'");
    const toml = parseConfigFile({ label: 'codex' }, '[mcp_servers.docs]\ncommand = "uvx"\nargs = ["docs-mcp", "--port", "1"]\n\n[mcp_servers.keyed]\ncommand = "x"\nenv = { TOKEN = "y" }\n');
    expect(toml).toEqual([expect.objectContaining({ name: 'docs', endpoint: 'uvx docs-mcp --port 1' })]);
  });
});

/** A fake ssh child process that records argv and replies with scripted output. */
function fakeSpawn(script: (args: string[]) => { code: number; stdout?: string[]; stderr?: string }) {
  const calls: { args: string[]; stdin: string }[] = [];
  const spawn = (_cmd: string, args: string[]): ChildProcessWithoutNullStreams => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const call = { args, stdin: '' };
    calls.push(call);
    Object.assign(child, { stdout, stderr, stdin, kill: () => { child.emit('close', null, 'SIGTERM'); return true; } });
    stdin.on('data', (d: Buffer) => { call.stdin += d.toString(); });
    stdin.on('finish', () => {
      const reply = script(args);
      for (const line of reply.stdout ?? []) stdout.write(`${line}\n`);
      if (reply.stderr) stderr.write(reply.stderr);
      stdout.end(); stderr.end();
      setImmediate(() => child.emit('close', reply.code, null));
    });
    return child;
  };
  return { spawn, calls };
}

describe('remote execution over SSH', () => {
  it('rejects option-like hosts and quotes remote arguments', () => {
    expect(() => assertSshHost('-oProxyCommand=evil')).toThrow();
    expect(() => assertSshHost('host; rm -rf /')).toThrow();
    expect(assertSshHost('dev@build-1.example.com')).toBe('dev@build-1.example.com');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('runs Codex in the remote directory with BatchMode and streams its JSONL', async () => {
    const { spawn, calls } = fakeSpawn((args) => {
      const remote = args[args.length - 1]!;
      if (remote === 'true' || remote.startsWith('command -v')) return { code: 0 };
      return { code: 0, stdout: [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'remote hello' } })] };
    });
    const registry = new Registry();
    const consents: string[] = [];
    const starts: string[] = [];
    const service = new RemoteHostService(store, audit, registry, (host) => { starts.push(host.host); }, (p) => { consents.push(p); },
      () => new SshRemoteTransport({ spawn }));
    const host = service.add({ name: 'Build', host: 'dev@build-1', remoteDir: '/srv/app', installIfMissing: false });
    expect(consents).toEqual(['ssh:dev@build-1']);
    expect(registry.adaptersSupporting(`objective.fulfill.remote:${host.id}`)).toHaveLength(1);

    const adapter = registry.resolve(`remote:${host.id}`);
    const handle = await adapter.start({ objective: 'say hi', rootPath: '/local/ignored', mode: 'read_only' });
    const events: unknown[] = [];
    for await (const event of adapter.stream(handle)) events.push(event.data);
    expect((await adapter.await(handle)).status).toBe('succeeded');
    expect(starts).toEqual(['dev@build-1']);
    expect(events).toContain(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'remote hello' } }));

    const exec = calls[calls.length - 1]!;
    expect(exec.args.slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
    expect(exec.args).toContain('--');
    const remote = exec.args[exec.args.length - 1]!;
    expect(remote).toContain(`'codex' 'exec' '--skip-git-repo-check' '--sandbox' 'read-only' '--cd' '/srv/app'`);
    expect(exec.stdin).toContain('say hi');
  });

  it('reports a missing agent instead of installing without permission', async () => {
    const { spawn } = fakeSpawn((args) => ({ code: args[args.length - 1] === 'true' ? 0 : 1 }));
    const transport = new SshRemoteTransport({ spawn });
    expect(await transport.test('dev@build-1')).toEqual({ connected: true, agentInstalled: false });
    await expect(transport.provisionAndInstall({ host: 'dev@build-1' })).rejects.toThrow(/not installed/);
  });
});
