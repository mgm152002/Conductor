import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import type { AgentModelCatalog, AgentModelOption } from '@shared/agent-models';
import { childEnv } from '../catalog/search-path';
import { defaultCliEnvironment, discoverOnPath } from '../adapters/local-cli-adapter';
import type { Registry } from '../registry/registry';
import { modelTier } from './model-routing';

// The models (and reasoning-effort levels) each agent CLI offers, for the
// composer and Settings pickers and for automatic routing. Lists come from the
// CLIs themselves where they can report them:
//   Codex       `codex app-server` → model/list (with per-model efforts)
//   Antigravity `agy models`; --effort low|medium|high|xhigh|max
//   OpenCode    ACP session/new → configOptions "model" (no effort setting)
//   Kiro        ACP session/new → configOptions "model" / effort, if offered
//   Claude Code aliases haiku / sonnet / opus; --effort low…max
// Results are cached for 10 minutes.

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;
const ID = /^[\w./:@-]{1,100}$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function option(id: string, label: string, extra: Partial<AgentModelOption> = {}): AgentModelOption {
  return { id, label, tier: modelTier({ id, label, ...(extra.description ? { description: extra.description } : {}) }), ...extra };
}

/** Run a JSON-RPC conversation with a stdio server and return what `talk` resolves. */
function rpcSession<T>(binary: string, args: string[], talk: (request: (method: string, params: unknown) => Promise<Json>, notify: (method: string, params?: unknown) => void) => Promise<T>, jsonrpc: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv(), cwd: tmpdir() });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the CLI did not answer in time')); }, TIMEOUT_MS);
    let next = 1;
    const waiting = new Map<number, (m: Json) => void>();
    const write = (m: Json): void => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(jsonrpc ? { jsonrpc: '2.0', ...m } : m)}\n`); };
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const m = obj(JSON.parse(line));
        if (m === null) return;
        if (typeof m['id'] === 'number' && m['method'] === undefined) { waiting.get(m['id'])?.(m); waiting.delete(m['id']); return; }
        // Requests from the server (permissions etc.) are refused.
        if (m['id'] !== undefined && typeof m['method'] === 'string') write({ id: m['id'], error: { code: -32601, message: 'not supported' } });
      } catch { /* ignore non-JSON */ }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.on('error', () => {});
    const request = (method: string, params: unknown): Promise<Json> => new Promise((res, rej) => {
      const id = next++;
      waiting.set(id, (m) => { const error = obj(m['error']); if (error) rej(new Error(str(error['message']) ?? 'request failed')); else res(obj(m['result']) ?? {}); });
      write({ id, method, params });
    });
    talk(request, (method, params) => { write({ method, ...(params !== undefined ? { params } : {}) }); })
      .then(resolve, reject)
      .finally(() => { clearTimeout(timer); child.kill('SIGTERM'); });
  });
}

function runText(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env: childEnv(), cwd: tmpdir(), timeout: TIMEOUT_MS, maxBuffer: 2_000_000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

async function codexCatalog(binary: string): Promise<AgentModelCatalog> {
  const listed = await rpcSession(binary, ['app-server'], async (request, notify) => {
    await request('initialize', { clientInfo: { name: 'conductor', version: '0.1.0' }, capabilities: null });
    notify('initialized');
    return request('model/list', { limit: 50 });
  }, false);
  const models = (Array.isArray(listed['data']) ? listed['data'] as unknown[] : []).map(obj).filter((m): m is Json => m !== null && m['hidden'] !== true && typeof m['model'] === 'string')
    .map((m) => {
      const efforts = (Array.isArray(m['supportedReasoningEfforts']) ? m['supportedReasoningEfforts'] as unknown[] : [])
        .map((e) => str(obj(e)?.['reasoningEffort']) ?? str(e)).filter((e): e is string => e !== undefined);
      return option(m['model'] as string, str(m['displayName']) ?? (m['model'] as string), {
        ...(str(m['description']) ? { description: str(m['description'])! } : {}), efforts, ...(m['isDefault'] === true ? { isDefault: true } : {}),
      });
    });
  const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))];
  return { agentId: 'codex', models, efforts, source: 'cli' };
}

async function antigravityCatalog(binary: string): Promise<AgentModelCatalog> {
  const text = await runText(binary, ['models']);
  // Antigravity bakes the reasoning effort INTO the model id: it exposes
  // separate "…-low" / "…-medium" / "…-high" models rather than a `--effort`
  // flag, and passing `--effort` alongside such a model is rejected as a
  // conflict. So no Antigravity model advertises a separate effort list; the
  // user chooses an effort by choosing the model variant.
  const models = text.split('\n').map((line) => line.split('\t')).filter((p) => p.length >= 2 && ID.test(p[0]!.trim()))
    .map(([id, label]) => option(id!.trim(), label!.trim()));
  return { agentId: 'antigravity', models, efforts: [], source: 'cli' };
}

async function acpCatalog(agentId: string, binary: string): Promise<AgentModelCatalog> {
  const created = await rpcSession(binary, ['acp'], async (request) => {
    await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    return request('session/new', { cwd: tmpdir(), mcpServers: [] });
  }, true);
  const options = (Array.isArray(created['configOptions']) ? created['configOptions'] as unknown[] : []).map(obj).filter((o): o is Json => o !== null);
  const values = (o: Json | undefined): Json[] => (Array.isArray(o?.['options']) ? (o!['options'] as unknown[]).map(obj).filter((v): v is Json => v !== null) : []);
  const modelOption = options.find((o) => o['id'] === 'model');
  const current = str(modelOption?.['currentValue']);
  let models = values(modelOption).filter((v) => typeof v['value'] === 'string').map((v) =>
    option(v['value'] as string, str(v['name']) ?? (v['value'] as string), { ...(str(v['description']) ? { description: str(v['description'])! } : {}), ...(v['value'] === current ? { isDefault: true } : {}) }));
  const legacy = obj(created['models']);
  if (models.length === 0 && legacy !== null && Array.isArray(legacy['availableModels'])) {
    models = (legacy['availableModels'] as unknown[]).map(obj).filter((m): m is Json => m !== null && typeof m['modelId'] === 'string')
      .map((m) => option(m['modelId'] as string, str(m['name']) ?? (m['modelId'] as string), m['modelId'] === legacy['currentModelId'] ? { isDefault: true } : {}));
  }
  const effortOption = options.find((o) => typeof o['id'] === 'string' && /effort|reasoning/i.test(o['id']));
  const efforts = values(effortOption).map((v) => str(v['value'])).filter((v): v is string => v !== undefined);
  return { agentId, models, efforts, source: 'cli' };
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE: AgentModelCatalog = {
  agentId: 'claude-code', source: 'builtin', efforts: CLAUDE_EFFORTS,
  // The `haiku`/`sonnet`/`opus` aliases accept `--effort`; the efforts are
  // attached per model so a pinned non-alias slug isn't assumed to support it.
  models: [
    option('haiku', 'Haiku', { description: 'Fastest, lowest cost', efforts: CLAUDE_EFFORTS }),
    option('sonnet', 'Sonnet', { description: 'Balanced', isDefault: true, efforts: CLAUDE_EFFORTS }),
    option('opus', 'Opus', { description: 'Most capable', efforts: CLAUDE_EFFORTS }),
  ],
};

export class ModelCatalogService {
  private readonly cache = new Map<string, { at: number; catalog: AgentModelCatalog }>();
  private readonly inFlight = new Map<string, Promise<AgentModelCatalog>>();

  constructor(private readonly registry: Registry) {}

  /** The cached catalog, if one was loaded recently (never blocks). */
  cached(agentId: string): AgentModelCatalog | undefined {
    if (agentId === 'claude-code') return CLAUDE;
    return this.cache.get(agentId)?.catalog;
  }

  /** Load (or reuse) an agent's catalog. Never throws; errors are in `error`. */
  async get(agentId: string, refresh = false): Promise<AgentModelCatalog> {
    if (agentId === 'claude-code') return CLAUDE;
    const hit = this.cache.get(agentId);
    if (!refresh && hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.catalog;
    const running = this.inFlight.get(agentId);
    if (running !== undefined) return running;
    const load = this.load(agentId).then((catalog) => {
      if (catalog.error === undefined) this.cache.set(agentId, { at: Date.now(), catalog });
      return catalog;
    }).finally(() => { this.inFlight.delete(agentId); });
    this.inFlight.set(agentId, load);
    return load;
  }

  /** Load catalogs for several agents at once (used before a run starts). */
  async warm(agentIds: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(agentIds)].map((id) => this.get(id)));
  }

  private async load(agentId: string): Promise<AgentModelCatalog> {
    const none = (error?: string): AgentModelCatalog => ({ agentId, models: [], efforts: [], source: 'none', ...(error ? { error } : {}) });
    if (!this.registry.has(agentId)) return none('This agent is not installed.');
    const command = obj(this.registry.resolve(agentId).record.config)?.['command'];
    const binary = typeof command === 'string' ? discoverOnPath(command, defaultCliEnvironment()) : undefined;
    if (binary === undefined) return none('This agent is not installed.');
    try {
      switch (agentId) {
        case 'codex': return await codexCatalog(binary);
        case 'antigravity': return await antigravityCatalog(binary);
        case 'opencode':
        case 'kiro': return await acpCatalog(agentId, binary);
        default: return none();
      }
    } catch (error) {
      return none(`Could not list models: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
