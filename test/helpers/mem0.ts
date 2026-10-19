import { randomUUID } from 'node:crypto';
import { Mem0Client, type Mem0Memory } from '@main/domain/mem0-client';

/** HTTP contract double only: production never performs local text matching. */
export function mockMem0() {
  const records = new Map<string, { id: string; memory: string; user_id: string; run_id: string; metadata: Record<string, unknown> }>();
  const requests: { path: string; method: string; body: any }[] = [];
  let offline = false;
  let loseAddResponse = false;
  let searchResults: Mem0Memory[] | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    if (offline) throw new Error('Mem0 offline');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname, method, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname === '/memories' && method === 'POST') {
      const id = randomUUID();
      const row = { id, memory: body.messages[0].content, user_id: body.user_id, run_id: body.run_id, metadata: body.metadata };
      records.set(id, row);
      if (loseAddResponse) { loseAddResponse = false; throw new Error('Lost response'); }
      return json({ results: [{ id, memory: row.memory, event: 'ADD' }] });
    }
    if (url.pathname === '/memories' && method === 'GET') {
      return json({ results: [...records.values()].filter((r) => r.user_id === url.searchParams.get('user_id') && (!url.searchParams.has('run_id') || r.run_id === url.searchParams.get('run_id'))) });
    }
    if (url.pathname === '/search') {
      if (searchResults !== undefined) return json({ results: searchResults });
      const ids = body.filters.conductor_id.in as string[];
      const terms = body.query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return json({ results: [...records.values()].filter((r) => r.user_id === body.filters.user_id && ids.includes(String(r.metadata['conductor_id'])))
        .map((r) => ({ ...r, score: terms.reduce((n: number, t: string) => n + r.memory.toLowerCase().split(t).length - 1, 0) }))
        .filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, body.top_k) });
    }
    const id = decodeURIComponent(url.pathname.slice('/memories/'.length));
    const row = records.get(id);
    if (!row) return json({ detail: 'not found' }, 404);
    if (method === 'DELETE') { records.delete(id); return json({ message: 'deleted' }); }
    if (method === 'PUT') { row.metadata = body.metadata; if (body.text) row.memory = body.text; return json({ message: 'updated' }); }
    return json(row);
  };
  return { client: new Mem0Client({ fetch: fetcher }), records, requests,
    setOffline(value: boolean) { offline = value; }, loseNextAddResponse() { loseAddResponse = true; },
    setSearchResults(value: Mem0Memory[]) { searchResults = value; } };
}
