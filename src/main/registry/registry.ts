// The Agent & Tool Registry: the in-memory catalog of every execution
// capability available to the orchestrator. It owns register/deregister,
// resolution by id, liveness probing, and capability-based lookup. Routing
// selection (task fit, cost, latency, historical performance) lives in the
// orchestrator's deterministic router; the Registry's job is only to catalog
// adapters and answer "which adapters declare this capability?".
//
// Every adapter must satisfy the full AgentAdapter contract before it is
// admitted. An adapter with an incomplete contract is rejected, never
// cataloged, and therefore never reachable by routing — the Registry returns a
// RegistryContractError naming exactly what is missing.

import type {
  AdapterClass,
  AdapterRecord,
  AgentAdapter,
  AgentSession,
  CapabilityDescriptor,
} from '@shared/adapter';

// The six adapter classes the Registry supports (Requirement 6.1).
const ADAPTER_CLASSES: readonly AdapterClass[] = [
  'local_cli_agent',
  'model_provider',
  'external_service',
  'local_tool',
  'computer_interaction',
  'remote_execution',
];

// The AgentAdapter methods every adapter must implement. `resume` is optional
// by contract, so it is intentionally excluded.
const REQUIRED_ADAPTER_METHODS = [
  'probeLiveness',
  'start',
  'stream',
  'await',
  'cancel',
] as const;

/**
 * Raised when an adapter submitted for registration does not satisfy the full
 * AgentAdapter contract. `missing` lists every missing or malformed contract
 * element so the caller can see exactly what to fix.
 */
export class RegistryContractError extends Error {
  constructor(
    readonly adapterId: string | undefined,
    readonly missing: string[],
  ) {
    const id = adapterId ?? '<unknown>';
    super(
      `Adapter ${id} has an incomplete AgentAdapter contract; missing: ${missing.join(', ')}`,
    );
    this.name = 'RegistryContractError';
  }
}

/** Raised when a duplicate adapter id is registered. */
export class RegistryDuplicateError extends Error {
  constructor(readonly adapterId: string) {
    super(`Adapter ${adapterId} is already registered`);
    this.name = 'RegistryDuplicateError';
  }
}

/** Raised when resolving an adapter id that is not registered. */
export class RegistryNotFoundError extends Error {
  constructor(readonly adapterId: string) {
    super(`Adapter ${adapterId} is not registered`);
    this.name = 'RegistryNotFoundError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

// Validate a single capability descriptor, pushing a path-qualified entry onto
// `missing` for each field that is absent or the wrong shape. Capability
// descriptors must carry input/output schemas, the streaming/cancellable/
// resumable flags, and a required-permissions array (Requirement 6.2).
function collectCapabilityIssues(
  capability: unknown,
  index: number,
  missing: string[],
): void {
  const path = `record.capabilities[${index}]`;
  if (typeof capability !== 'object' || capability === null) {
    missing.push(path);
    return;
  }
  const cap = capability as Partial<CapabilityDescriptor>;

  if (!isNonEmptyString(cap.id)) missing.push(`${path}.id`);
  if (!isNonEmptyString(cap.title)) missing.push(`${path}.title`);
  // Schemas may be any JSON-serializable shape, but must be present (not
  // undefined) so routing can validate step I/O against them.
  if (cap.inputSchema === undefined) missing.push(`${path}.inputSchema`);
  if (cap.outputSchema === undefined) missing.push(`${path}.outputSchema`);
  if (typeof cap.streaming !== 'boolean') missing.push(`${path}.streaming`);
  if (typeof cap.cancellable !== 'boolean') missing.push(`${path}.cancellable`);
  if (typeof cap.resumable !== 'boolean') missing.push(`${path}.resumable`);
  if (!Array.isArray(cap.requiredPermissions)) {
    missing.push(`${path}.requiredPermissions`);
  }
}

// Validate the AdapterRecord the adapter advertises. Returns the list of
// missing/malformed elements (empty when complete).
function collectRecordIssues(record: unknown, missing: string[]): void {
  if (typeof record !== 'object' || record === null) {
    missing.push('record');
    return;
  }
  const rec = record as Partial<AdapterRecord>;

  if (!isNonEmptyString(rec.id)) missing.push('record.id');
  if (!isNonEmptyString(rec.name)) missing.push('record.name');
  if (!isNonEmptyString(rec.version)) missing.push('record.version');
  if (typeof rec.available !== 'boolean') missing.push('record.available');

  if (rec.class === undefined || !ADAPTER_CLASSES.includes(rec.class)) {
    missing.push('record.class');
  }

  if (!Array.isArray(rec.capabilities)) {
    missing.push('record.capabilities');
  } else {
    rec.capabilities.forEach((capability, index) => {
      collectCapabilityIssues(capability, index, missing);
    });
  }
}

/**
 * Validate the full AgentAdapter contract. Returns every missing or malformed
 * element; an empty array means the adapter is complete and admissible.
 */
export function validateAdapterContract(adapter: unknown): string[] {
  const missing: string[] = [];

  if (typeof adapter !== 'object' || adapter === null) {
    return ['adapter'];
  }

  const candidate = adapter as Partial<AgentAdapter> & Record<string, unknown>;

  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (!isFunction(candidate[method])) {
      missing.push(`${method}()`);
    }
  }

  collectRecordIssues(candidate.record, missing);

  return missing;
}

export class Registry {
  private readonly adapters = new Map<string, AgentAdapter>();

  /**
   * Register an adapter after validating its full AgentAdapter contract. An
   * adapter with an incomplete contract is rejected with a RegistryContractError
   * naming the missing elements and is never cataloged (and so never routed).
   * A duplicate id is rejected with a RegistryDuplicateError.
   */
  register(adapter: AgentAdapter): void {
    const missing = validateAdapterContract(adapter);
    if (missing.length > 0) {
      const id =
        typeof adapter === 'object' &&
        adapter !== null &&
        typeof adapter.record?.id === 'string'
          ? adapter.record.id
          : undefined;
      throw new RegistryContractError(id, missing);
    }

    const id = adapter.record.id;
    if (this.adapters.has(id)) {
      throw new RegistryDuplicateError(id);
    }

    this.adapters.set(id, adapter);
  }

  /**
   * Deregister an adapter by id, removing it from the catalog so the change is
   * reflected in the next routing request. Returns true when an adapter was
   * removed, false when no adapter with that id was registered.
   */
  deregister(adapterId: string): boolean {
    return this.adapters.delete(adapterId);
  }

  /** Resolve a registered adapter by id, throwing when it is not registered. */
  resolve(adapterId: string): AgentAdapter {
    const adapter = this.adapters.get(adapterId);
    if (adapter === undefined) {
      throw new RegistryNotFoundError(adapterId);
    }
    return adapter;
  }

  /** Whether an adapter with the given id is currently registered. */
  has(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }

  /** Every registered adapter's record (ordered by registration). */
  listAdapters(): AdapterRecord[] {
    return [...this.adapters.values()].map((adapter) => adapter.record);
  }

  /**
   * Return the records of every adapter that declares the given capability.
   * Returns an empty array when no registered adapter declares it. Reflects the
   * current catalog, so register/deregister changes appear in the next query.
   */
  adaptersSupporting(capabilityId: string): AdapterRecord[] {
    const result: AdapterRecord[] = [];
    for (const adapter of this.adapters.values()) {
      const declares = adapter.record.capabilities.some(
        (capability) => capability.id === capabilityId,
      );
      if (declares) {
        result.push(adapter.record);
      }
    }
    return result;
  }

  /**
   * Probe the liveness of a persisted session by delegating to the adapter that
   * owns it. A session referencing an unregistered adapter cannot be alive, so
   * this reports `false` (the Resume Center reconciles rather than trusting a
   * stale "live" state).
   */
  async probeLiveness(session: AgentSession): Promise<boolean> {
    const adapter = this.adapters.get(session.adapterId);
    if (adapter === undefined) {
      return false;
    }
    return adapter.probeLiveness(session);
  }
}
