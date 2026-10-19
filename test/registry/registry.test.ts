import { describe, expect, it } from 'vitest';
import {
  Registry,
  RegistryContractError,
  RegistryDuplicateError,
  RegistryNotFoundError,
  validateAdapterContract,
} from '@main/registry/registry';
import type {
  AdapterClass,
  AdapterRecord,
  AgentAdapter,
  AgentSession,
  CapabilityDescriptor,
} from '@shared/adapter';

function makeCapability(
  overrides: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  return {
    id: 'text.summarize',
    title: 'Summarize text',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    streaming: false,
    cancellable: true,
    resumable: false,
    requiredPermissions: [],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<AdapterRecord> = {}): AdapterRecord {
  return {
    id: 'adapter-1',
    class: 'local_tool',
    name: 'Fake Adapter',
    version: '1.0.0',
    capabilities: [makeCapability()],
    available: true,
    config: {},
    ...overrides,
  };
}

function makeAdapter(record: AdapterRecord = makeRecord()): AgentAdapter {
  return {
    record,
    probeLiveness: async () => true,
    start: async () => ({
      sessionId: 's1',
      adapterId: record.id,
      resumable: false,
    }),
    // eslint-disable-next-line require-yield
    async *stream() {
      return;
    },
    await: async () => ({ status: 'succeeded' as const }),
    cancel: async () => {},
  };
}

describe('validateAdapterContract', () => {
  it('accepts a complete adapter', () => {
    expect(validateAdapterContract(makeAdapter())).toEqual([]);
  });

  it('reports missing required methods', () => {
    const adapter = makeAdapter();
    const broken = { ...adapter } as Record<string, unknown>;
    delete broken.cancel;
    delete broken.stream;
    const missing = validateAdapterContract(broken);
    expect(missing).toContain('cancel()');
    expect(missing).toContain('stream()');
  });

  it('does not require the optional resume method', () => {
    const adapter = makeAdapter();
    expect('resume' in adapter).toBe(false);
    expect(validateAdapterContract(adapter)).toEqual([]);
  });

  it('reports a malformed capability descriptor', () => {
    const record = makeRecord({
      capabilities: [
        makeCapability({
          streaming: undefined as unknown as boolean,
          inputSchema: undefined,
        }),
      ],
    });
    const missing = validateAdapterContract(makeAdapter(record));
    expect(missing).toContain('record.capabilities[0].streaming');
    expect(missing).toContain('record.capabilities[0].inputSchema');
  });

  // The AgentAdapter contract requires every capability to advertise its I/O
  // schemas, its cancellation/streaming/resumable session support, and its
  // permission requirements (Requirement 6.2). Each absent element must be
  // named individually so the author sees exactly what the contract is missing.
  it('reports every missing capability contract element the adapter must expose', () => {
    const record = makeRecord({
      capabilities: [
        makeCapability({
          outputSchema: undefined,
          cancellable: undefined as unknown as boolean,
          resumable: undefined as unknown as boolean,
          requiredPermissions: undefined as unknown as [],
        }),
      ],
    });
    const missing = validateAdapterContract(makeAdapter(record));
    expect(missing).toContain('record.capabilities[0].outputSchema');
    expect(missing).toContain('record.capabilities[0].cancellable');
    expect(missing).toContain('record.capabilities[0].resumable');
    expect(missing).toContain('record.capabilities[0].requiredPermissions');
  });

  it('reports an unknown adapter class', () => {
    const record = makeRecord({ class: 'not_a_class' as AdapterClass });
    expect(validateAdapterContract(makeAdapter(record))).toContain(
      'record.class',
    );
  });
});

describe('Registry registration and contract validation', () => {
  it('registers a complete adapter and exposes its record', () => {
    const registry = new Registry();
    const adapter = makeAdapter();
    registry.register(adapter);
    expect(registry.has('adapter-1')).toBe(true);
    expect(registry.listAdapters()).toHaveLength(1);
    expect(registry.resolve('adapter-1')).toBe(adapter);
  });

  it('rejects an incomplete adapter, excludes it, and names missing elements', () => {
    const registry = new Registry();
    const broken = { ...makeAdapter() } as Record<string, unknown>;
    delete broken.await;
    (broken.record as AdapterRecord) = makeRecord({
      version: '' as unknown as string,
    });

    let error: unknown;
    try {
      registry.register(broken as unknown as AgentAdapter);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RegistryContractError);
    const contractError = error as RegistryContractError;
    expect(contractError.missing).toContain('await()');
    expect(contractError.missing).toContain('record.version');
    // Excluded from the catalog and from routing.
    expect(registry.has('adapter-1')).toBe(false);
    expect(registry.adaptersSupporting('text.summarize')).toEqual([]);
    expect(registry.listAdapters()).toEqual([]);
    // A rejected adapter is never resolvable either (Requirement 6.3).
    expect(() => registry.resolve('adapter-1')).toThrow(RegistryNotFoundError);
  });

  it('rejects an adapter whose capability omits its required permissions', () => {
    const registry = new Registry();
    const record = makeRecord({
      capabilities: [
        makeCapability({
          requiredPermissions: undefined as unknown as [],
        }),
      ],
    });

    let error: unknown;
    try {
      registry.register(makeAdapter(record));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RegistryContractError);
    expect((error as RegistryContractError).missing).toContain(
      'record.capabilities[0].requiredPermissions',
    );
    expect(registry.has('adapter-1')).toBe(false);
  });

  it('rejects a duplicate adapter id', () => {
    const registry = new Registry();
    registry.register(makeAdapter());
    expect(() => registry.register(makeAdapter())).toThrow(
      RegistryDuplicateError,
    );
  });

  it('resolve throws for an unknown id', () => {
    const registry = new Registry();
    expect(() => registry.resolve('nope')).toThrow(RegistryNotFoundError);
  });
});

describe('Registry capability query', () => {
  it('returns only adapters that declare the capability', () => {
    const registry = new Registry();
    registry.register(
      makeAdapter(
        makeRecord({
          id: 'summarizer',
          capabilities: [makeCapability({ id: 'text.summarize' })],
        }),
      ),
    );
    registry.register(
      makeAdapter(
        makeRecord({
          id: 'editor',
          capabilities: [makeCapability({ id: 'code.edit' })],
        }),
      ),
    );

    const supporting = registry.adaptersSupporting('text.summarize');
    expect(supporting.map((r) => r.id)).toEqual(['summarizer']);
  });

  it('returns an empty set when no adapter declares the capability', () => {
    const registry = new Registry();
    registry.register(makeAdapter());
    expect(registry.adaptersSupporting('unknown.capability')).toEqual([]);
  });

  // One adapter can declare several capabilities; a query for any one of them
  // must return that adapter (Requirement 6.5).
  it('returns an adapter for each capability it declares', () => {
    const registry = new Registry();
    registry.register(
      makeAdapter(
        makeRecord({
          id: 'multi',
          capabilities: [
            makeCapability({ id: 'text.summarize' }),
            makeCapability({ id: 'code.edit' }),
          ],
        }),
      ),
    );

    expect(registry.adaptersSupporting('text.summarize').map((r) => r.id)).toEqual([
      'multi',
    ]);
    expect(registry.adaptersSupporting('code.edit').map((r) => r.id)).toEqual([
      'multi',
    ]);
  });

  it('supports all six adapter classes', () => {
    const registry = new Registry();
    const classes: AdapterClass[] = [
      'local_cli_agent',
      'model_provider',
      'external_service',
      'local_tool',
      'computer_interaction',
      'remote_execution',
    ];
    classes.forEach((cls, i) => {
      registry.register(
        makeAdapter(
          makeRecord({
            id: `adapter-${i}`,
            class: cls,
            capabilities: [makeCapability({ id: 'cap.shared' })],
          }),
        ),
      );
    });
    expect(registry.adaptersSupporting('cap.shared')).toHaveLength(6);
  });
});

describe('Registry register/deregister reflected in next query', () => {
  it('reflects registration and deregistration in the next capability query', () => {
    const registry = new Registry();
    expect(registry.adaptersSupporting('text.summarize')).toEqual([]);

    registry.register(makeAdapter());
    expect(registry.adaptersSupporting('text.summarize').map((r) => r.id)).toEqual(
      ['adapter-1'],
    );

    expect(registry.deregister('adapter-1')).toBe(true);
    expect(registry.adaptersSupporting('text.summarize')).toEqual([]);
    expect(registry.has('adapter-1')).toBe(false);
  });

  it('deregister returns false for an unknown id', () => {
    const registry = new Registry();
    expect(registry.deregister('missing')).toBe(false);
  });

  // Deregistration frees the id so the same adapter can be registered again and
  // becomes available for routing once more (Requirement 6.4).
  it('allows re-registering an id after it is deregistered', () => {
    const registry = new Registry();
    registry.register(makeAdapter());
    expect(registry.deregister('adapter-1')).toBe(true);
    expect(() => registry.register(makeAdapter())).not.toThrow();
    expect(registry.adaptersSupporting('text.summarize').map((r) => r.id)).toEqual(
      ['adapter-1'],
    );
  });
});

describe('Registry liveness probing', () => {
  it('delegates liveness to the owning adapter', async () => {
    const registry = new Registry();
    registry.register(makeAdapter());
    const session: AgentSession = {
      id: 'sess-1',
      taskId: 'task-1',
      adapterId: 'adapter-1',
      status: 'live',
      resumable: false,
      createdAt: new Date().toISOString(),
    };
    await expect(registry.probeLiveness(session)).resolves.toBe(true);
  });

  it('reports not-live for a session owned by an unregistered adapter', async () => {
    const registry = new Registry();
    const session: AgentSession = {
      id: 'sess-1',
      taskId: 'task-1',
      adapterId: 'ghost',
      status: 'unknown',
      resumable: false,
      createdAt: new Date().toISOString(),
    };
    await expect(registry.probeLiveness(session)).resolves.toBe(false);
  });
});
