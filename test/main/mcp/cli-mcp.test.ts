import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliMcpManager, type CliRunner } from '@main/mcp/cli-mcp';

// The manager reads each CLI's own MCP config and writes through each CLI's
// own `mcp add` / `mcp remove`. These tests use a temporary home and a fake
// runner, so no real CLI or real config is touched.

let home: string;
let calls: Array<{ exe: string; args: string[] }>;
let codexList: unknown[];

const BIN: Record<string, string> = {
  claude: '/bin/claude', codex: '/bin/codex', opencode: '/bin/opencode', agy: '/bin/agy', 'kiro-cli': '/bin/kiro-cli',
};

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const run: CliRunner = async (exe, args) => {
  calls.push({ exe, args });
  if (exe === BIN['codex'] && args.join(' ') === 'mcp list --json') return { stdout: JSON.stringify(codexList) };
  return { stdout: '' };
};

function manager(installed: string[] = Object.keys(BIN)): CliMcpManager {
  return new CliMcpManager({
    home,
    statePath: join(home, 'state.json'),
    run,
    which: (binary) => (installed.includes(binary) ? BIN[binary] : undefined),
  });
}

const adds = (): Array<{ exe: string; args: string[] }> => calls.filter((call) => call.args[0] === 'mcp' && call.args[1] === 'add');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cli-mcp-'));
  process.env['XDG_CONFIG_HOME'] = join(home, '.config');
  calls = [];
  codexList = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env['XDG_CONFIG_HOME'];
});

describe('CliMcpManager', () => {
  it('lists each server once with where it is installed', async () => {
    write(join(home, '.kiro/settings/mcp.json'), { mcpServers: { atlassian: { url: 'https://mcp.atlassian.com/v1/sse' } } });
    write(join(home, '.claude.json'), { mcpServers: { Atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1/sse' } } });
    const overview = await manager().overview();
    expect(overview.servers).toHaveLength(1);
    const server = overview.servers[0]!;
    expect(server.key).toBe('atlassian');
    expect(server.presence['kiro']?.state).toBe('installed');
    expect(server.presence['claude-code']?.state).toBe('installed');
    expect(server.presence['codex']?.state).toBe('missing');
  });

  it('copies a server from one CLI into every other CLI through their own mcp add', async () => {
    write(join(home, '.kiro/settings/mcp.json'), {
      mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'secret' } } },
    });
    const report = await manager().sync();
    expect(report.failed).toEqual([]);
    expect(report.installed.map((item) => item.cli).sort()).toEqual(['antigravity', 'claude-code', 'codex', 'opencode']);
    const byExe = Object.fromEntries(adds().map((call) => [call.exe, call.args]));
    expect(byExe['/bin/claude']).toEqual(['mcp', 'add', '--scope', 'user', '--env', 'GITHUB_TOKEN=secret', 'github', '--', 'npx', '-y', '@modelcontextprotocol/server-github']);
    expect(byExe['/bin/codex']).toEqual(['mcp', 'add', 'github', '--env', 'GITHUB_TOKEN=secret', '--', 'npx', '-y', '@modelcontextprotocol/server-github']);
    expect(byExe['/bin/opencode']).toEqual(['mcp', 'add', '--global', '--env', 'GITHUB_TOKEN=secret', 'github', '--', 'npx', '-y', '@modelcontextprotocol/server-github']);
    expect(byExe['/bin/agy']).toEqual(['mcp', 'add', '--env', 'GITHUB_TOKEN=secret', 'github', '--', 'npx', '-y', '@modelcontextprotocol/server-github']);
    // Kiro already has it.
    expect(byExe['/bin/kiro-cli']).toBeUndefined();
  });

  it('never copies servers that only work inside one CLI', async () => {
    codexList = [
      { name: 'computer-use', enabled: true, transport: { type: 'stdio', command: './Computer Use.app/client', args: ['mcp'], cwd: '.', env_vars: [] } },
      { name: 'node_repl', enabled: true, transport: { type: 'stdio', command: '/Applications/X.app/node_repl', args: [], env_vars: ['PIPE_PATH'] } },
    ];
    const report = await manager().sync();
    expect(report.installed).toEqual([]);
    expect(adds()).toEqual([]);
    const overview = await manager().overview();
    expect(overview.servers.every((server) => !server.portable)).toBe(true);
  });

  it('skips CLIs that cannot store a remote server’s headers', async () => {
    write(join(home, '.claude.json'), { mcpServers: { api: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer t' } } } });
    await manager().sync();
    const targets = adds().map((call) => call.exe).sort();
    expect(targets).toEqual(['/bin/agy', '/bin/opencode']);
    const overview = await manager().overview();
    expect(overview.servers[0]!.presence['codex']?.state).toBe('unsupported');
    expect(overview.servers[0]!.presence['kiro']?.state).toBe('unsupported');
  });

  it('does not put back a server the user removed from one CLI', async () => {
    write(join(home, '.kiro/settings/mcp.json'), { mcpServers: { docs: { url: 'https://docs.example.com/mcp' } } });
    const subject = manager(['kiro-cli', 'claude']);
    await subject.removeFromCli('docs', 'claude-code');
    calls = [];
    const report = await subject.sync();
    expect(report.installed).toEqual([]);
    expect((await subject.overview()).servers[0]!.presence['claude-code']?.state).toBe('excluded');
    // Installing it there again clears the exclusion.
    await subject.installExisting('docs', 'claude-code');
    expect(adds().map((call) => call.exe)).toEqual(['/bin/claude']);
  });

  it('installs a new server into only the chosen CLIs, and only where it is missing', async () => {
    const subject = manager(['claude', 'codex', 'kiro-cli']);
    await subject.add({ name: 'weather', endpoint: 'https://weather.example.com/mcp', clis: ['claude-code', 'kiro'] });
    expect(adds().map((call) => call.exe).sort()).toEqual(['/bin/claude', '/bin/kiro-cli']);
    expect(adds().find((call) => call.exe === '/bin/kiro-cli')!.args).toEqual(['mcp', 'add', '--scope', 'global', '--name', 'weather', '--url', 'https://weather.example.com/mcp']);
    await expect(subject.add({ name: 'bad name!', endpoint: 'npx x' })).rejects.toThrow(/name/i);
    await expect(subject.add({ name: 'plain', endpoint: 'http://example.com/mcp' })).rejects.toThrow(/https/);
  });

  it('removes from OpenCode by editing its JSON config, keeping everything else', async () => {
    const path = join(home, '.config/opencode/opencode.json');
    write(path, { theme: 'dark', mcp: { github: { type: 'local', command: ['npx', 'gh'] }, other: { type: 'remote', url: 'https://o.example.com' } } });
    await manager(['opencode']).removeEverywhere('github');
    const after = JSON.parse(readFileSync(path, 'utf8')) as { theme: string; mcp: Record<string, unknown> };
    expect(after.theme).toBe('dark');
    expect(Object.keys(after.mcp)).toEqual(['other']);
  });

  it('leaves auto-sync off until the user turns it on', async () => {
    write(join(home, '.kiro/settings/mcp.json'), { mcpServers: { docs: { url: 'https://docs.example.com/mcp' } } });
    const subject = manager(['kiro-cli', 'claude']);
    const overview = await subject.overview({ sync: true });
    expect(overview.autoSync).toBe(false);
    expect(adds()).toEqual([]);
    // Turning it on syncs right away.
    const enabled = await subject.setAutoSync(true);
    expect(enabled.autoSync).toBe(true);
    expect(adds().map((call) => call.exe)).toEqual(['/bin/claude']);
  });

  it('installs into just the one CLI the user picks', async () => {
    const subject = manager();
    await subject.add({ name: 'notes', endpoint: 'npx -y notes-mcp', clis: ['opencode'] });
    expect(adds().map((call) => call.exe)).toEqual(['/bin/opencode']);
  });

  it('respects the auto-sync switch', async () => {
    write(join(home, '.kiro/settings/mcp.json'), { mcpServers: { docs: { url: 'https://docs.example.com/mcp' } } });
    const subject = manager(['kiro-cli', 'claude']);
    await subject.setAutoSync(false);
    calls = [];
    const overview = await subject.overview({ sync: true });
    expect(overview.autoSync).toBe(false);
    expect(overview.sync).toBeUndefined();
    expect(adds()).toEqual([]);
  });
});
