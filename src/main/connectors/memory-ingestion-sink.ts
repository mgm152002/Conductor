import type { MemoryEngine } from '../domain/memory-engine';
import { redact } from '../ipc/redaction';
import { revealForDisplayOnly } from '../orchestrator/data-channel';
import type { IngestionSink } from './ingestion-worker';

// Persists ingested connector content in Mem0 so it survives
// restarts, is searchable from the Memory screen, and can be retrieved as
// labelled untrusted reference data for tasks in the connector's project.
//
// Trust: content is stored as `unverified_assumption` with method `ingested`;
// MemoryEngine never elevates ingested content to observed_fact. Recognizable
// credentials are redacted before storage (defense in depth; arbitrary unknown
// secrets cannot be identified by pattern).

/** Upper bound on stored content per item. Larger items are truncated. */
export const MAX_INGESTED_MEMORY_CHARS = 32_000;

export function createMemoryIngestionSink(memory: MemoryEngine): IngestionSink {
  return async ({ connector, item, data, previous }) => {
    const raw = revealForDisplayOnly(data);
    const redacted = redact(raw);
    const text = typeof redacted === 'string' ? redacted : raw;
    if (text.trim() === '') return undefined;
    const truncated = text.length > MAX_INGESTED_MEMORY_CHARS;
    const body = truncated ? text.slice(0, MAX_INGESTED_MEMORY_CHARS) : text;
    const label = item.provenance.origin ?? item.externalId ?? item.id;
    const content = [
      `[${connector.name}] ${label}`,
      body,
      ...(truncated ? [`… (truncated at ${MAX_INGESTED_MEMORY_CHARS.toLocaleString('en-US')} characters)`] : []),
    ].join('\n\n');

    const input = {
      layer: 'project' as const,
      content,
      scope: { level: 'source' as const, refId: connector.id },
      veracity: 'unverified_assumption' as const,
      confidence: 0.5,
      provenance: { method: 'ingested' as const, sourceId: item.id },
    };

    // A changed source item supersedes its previous memory so search and task
    // retrieval only ever see the latest version.
    if (previous?.memoryId !== undefined) {
      const prior = await memory.find(previous.memoryId);
      if (prior !== undefined && prior.supersededBy === undefined) {
        return (await memory.supersede(prior.id, input)).id;
      }
    }
    // Recover a staged write after a transport failure without duplicating
    // it. This is a local lookup only: the previous search-based recovery
    // synchronized with Mem0 and fetched the remote record for every file.
    const recoveredId = memory.idForSourceId(item.id);
    if (recoveredId !== undefined) return recoveredId;
    return (await memory.create(input)).id;
  };
}
