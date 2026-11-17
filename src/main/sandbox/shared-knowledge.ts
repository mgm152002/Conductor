import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { SHARED_MEMORY_NAMESPACE, type Mem0Notes } from './agent-memory';

const CHUNK = 1_500;
const MAX_CHUNKS_PER_FILE = 40;
const COPY_WORKERS = 6;
const RESYNC_MS = 5 * 60_000;

interface Entry { hash: string; ids: string[] }

/** Splits text into pieces of about CHUNK characters, preferring paragraph breaks. */
export function chunkText(text: string): string[] {
  const out: string[] = [];
  let current = '';
  const push = (): void => { if (current.trim() !== '') out.push(current.trim()); current = ''; };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current.length + paragraph.length + 2 > CHUNK) push();
    if (paragraph.length > CHUNK) {
      for (let i = 0; i < paragraph.length; i += CHUNK) { current = paragraph.slice(i, i + CHUNK); push(); }
    } else current += `${current === '' ? '' : '\n\n'}${paragraph}`;
  }
  push();
  return out.slice(0, MAX_CHUNKS_PER_FILE);
}

/**
 * Copies the files in the sandbox Docker volumes into Mem0 so agents can find
 * them by meaning: the shared volume into the shared namespace, an agent's
 * workspace volume into that agent's private namespace. A file is re-copied only
 * when its content changed, and removed from Mem0 when it leaves the volume.
 * What was copied is remembered in a small local file.
 */
export class SharedKnowledgeSync {
  private running: Promise<void> | undefined;
  private last = 0;

  constructor(private readonly options: {
    mem0: Mem0Notes;
    /** The non-empty volumes, each with the Mem0 namespace its files belong in. */
    sources: () => Promise<Array<{ namespace: string; files: Array<{ path: string; content: string }> }>>;
    stateFile: string;
    now?: () => number;
  }) {}

  private load(): Record<string, Entry> {
    try { return JSON.parse(readFileSync(this.options.stateFile, 'utf8')) as Record<string, Entry>; } catch { return {}; }
  }

  /** Sync now, or soon after the last sync; never throws. Concurrent calls share one run. */
  request(force = false): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    if (this.running !== undefined) return this.running;
    if (!force && now - this.last < RESYNC_MS) return Promise.resolve();
    this.last = now;
    this.running = this.sync().catch(() => { this.last = 0; }).finally(() => { this.running = undefined; });
    return this.running;
  }

  async sync(): Promise<void> {
    const { mem0 } = this.options;
    const sources = (await this.options.sources()).filter((source) => source.files.length > 0);
    const state = this.load();
    const seen = new Set<string>();
    const save = (): void => { try { writeFileSync(this.options.stateFile, JSON.stringify(state)); } catch { /* retried next sync */ } };
    // The shared folder first, then each agent's workspace; several files at a time.
    const jobs = [...sources].sort((x, y) => Number(y.namespace === SHARED_MEMORY_NAMESPACE) - Number(x.namespace === SHARED_MEMORY_NAMESPACE))
      .flatMap(({ namespace, files }) => files.map((file) => ({ namespace, file })));
    for (const { namespace, file } of jobs) seen.add(`${namespace}|${file.path}`);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let job = jobs[next++]; job !== undefined; job = jobs[next++]) {
        const { namespace, file } = job;
        const key = `${namespace}|${file.path}`;
        const hash = createHash('sha256').update(file.content).digest('hex');
        if (state[key]?.hash === hash) continue;
        for (const id of state[key]?.ids ?? []) await mem0.delete(id).catch(() => undefined);
        const ids: string[] = [];
        const pieces = chunkText(file.content);
        for (const [index, piece] of pieces.entries()) {
          const note = await mem0.addNote(namespace, `From the sandbox folder, file ${file.path}${pieces.length > 1 ? ` (part ${index + 1} of ${pieces.length})` : ''}:\n${piece}`,
            { source: 'shared-volume', path: file.path });
          ids.push(note.id);
        }
        state[key] = { hash, ids };
        save();
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_WORKERS, jobs.length) }, worker));
    // Files that left a volume we could read are removed; an unreadable
    // (empty) result leaves earlier copies alone.
    const readable = new Set(sources.map((source) => source.namespace));
    for (const key of Object.keys(state)) {
      if (seen.has(key) || !readable.has(key.slice(0, key.indexOf('|')))) continue;
      for (const id of state[key]!.ids) await mem0.delete(id).catch(() => undefined);
      delete state[key];
      save();
    }
  }
}
