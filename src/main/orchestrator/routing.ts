// Deterministic capability-based routing (Requirement 6.6, 6.7).
//
// `selectAdapters` turns a set of planned steps into routing decisions. For
// each step it:
//
//   1. asks the Registry which adapters declare the step's required capability
//      (`adaptersSupporting`),
//   2. keeps only candidates that are `available` AND whose permission
//      requirements are satisfiable for the active permission subject under the
//      active Permission_Profile (via the PermissionService), and
//   3. deterministically picks exactly one adapter from the survivors using a
//      fixed precedence — task fit, availability, cost, latency, permission
//      satisfiability, historical performance, then the shared agent
//      preference order — with a stable lexicographic tiebreaker on adapter id
//      so identical inputs always yield the identical single selection
//      (Requirement 6.6).
//
// When no available adapter satisfies a step's capability and permissions, the
// step is flagged for deterministic fallback if the caller supplied a fallback
// automation for that capability, otherwise it is marked BLOCKED
// (Requirement 6.7).
//
// Determinism is the central property of this module: it performs no I/O, reads
// the clock from nothing, and never iterates a Map/Set whose order is not
// derived from the inputs. Every comparator stage is total and ends in a
// lexicographic adapter-id tiebreaker, so `selectAdapters(sameInputs)` is a
// pure function of its arguments.

import type {
  AdapterRecord,
  CapabilityDescriptor,
  CostHint,
  LatencyHint,
  PermissionRequirement,
} from '@shared/adapter';
import { agentPreferenceRank } from '@shared/agent-preference';
import type { Registry } from '../registry/registry';
import type {
  PermissionService,
  PermissionSubject,
} from '../domain/permission-service';

/** A planned step handed to the router, before an adapter is assigned. */
export interface RoutableStep {
  /** Stable step identifier, used for reporting and audit. */
  readonly id: string;
  /** The capability id the step needs an adapter to provide. */
  readonly requiredCapability: string;
  /**
   * Permissions the step will exercise. A candidate adapter is only eligible
   * when every one of these is satisfiable for the routing subject under the
   * active profile. Optional; an empty/omitted list means the step needs no
   * special permission.
   */
  readonly requiredPermissions?: readonly PermissionRequirement[];
}

/**
 * How a step was resolved. Exactly one adapter is assigned (`assigned`), the
 * step falls back to deterministic automation (`fallback`), or no eligible
 * adapter exists and the step is blocked (`blocked`).
 */
export type RoutingDecisionKind = 'assigned' | 'fallback' | 'blocked';

/** Why no adapter could be assigned, for `fallback`/`blocked` decisions. */
export type RoutingUnroutableReason =
  | 'no_candidates' // registry declared no adapter for the capability
  | 'none_available' // candidates exist but none are available
  | 'permissions_unsatisfiable'; // available candidates, none permission-eligible

export interface RoutingDecision {
  readonly stepId: string;
  readonly requiredCapability: string;
  readonly kind: RoutingDecisionKind;
  /** Set when `kind === 'assigned'`: the single chosen adapter id. */
  readonly assignedAdapterId?: string;
  /**
   * Set when `kind === 'fallback'`: the deterministic automation id the caller
   * registered for this capability.
   */
  readonly fallbackAutomationId?: string;
  /** Set when `kind !== 'assigned'`: why no adapter was chosen. */
  readonly reason?: RoutingUnroutableReason;
}

/**
 * Optional historical-performance oracle. Returns a normalized success score in
 * [0, 1] for an adapter/capability pair (higher is better). Must be a pure
 * function of its inputs for routing to stay deterministic. When omitted every
 * candidate is treated as having no history (score 0), so earlier precedence
 * stages and the id tiebreaker decide.
 */
export type HistoricalPerformance = (
  adapterId: string,
  capabilityId: string,
) => number;

/**
 * Optional map from capability id to a deterministic fallback automation id.
 * When a step has no eligible adapter but its capability appears here, the step
 * is flagged for that fallback instead of being blocked (Requirement 6.7).
 */
export type FallbackAutomations = ReadonlyMap<string, string>;

export interface SelectAdaptersInput {
  readonly steps: readonly RoutableStep[];
  readonly registry: Registry;
  readonly permissions: PermissionService;
  /** The subject (agent/workflow) whose grants gate permission satisfiability. */
  readonly subject: PermissionSubject;
  readonly historicalPerformance?: HistoricalPerformance;
  readonly fallbackAutomations?: FallbackAutomations;
}

// ---- Scoring primitives (all deterministic, no I/O) ----

// Cost/latency hints are ordinal; lower is better. An absent hint is treated as
// the neutral `medium` so adapters that omit a hint neither win nor lose purely
// by omission.
const HINT_RANK: Readonly<Record<CostHint & LatencyHint, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

function rankHint(hint: CostHint | LatencyHint | undefined): number {
  return hint === undefined ? HINT_RANK.medium : HINT_RANK[hint];
}

function findCapability(
  record: AdapterRecord,
  capabilityId: string,
): CapabilityDescriptor | undefined {
  return record.capabilities.find((c) => c.id === capabilityId);
}

/**
 * Task fit for a candidate against a step: higher is better. The capability is
 * guaranteed present (the candidate was selected because it declares it). We
 * reward a capability whose declared required permissions are a subset of the
 * step's — i.e. it asks for no more privilege than the step already needs —
 * which is a deterministic, inputs-only measure of how squarely the adapter
 * matches the step. A capability that demands privileges beyond the step's
 * scores lower.
 */
function taskFit(capability: CapabilityDescriptor, step: RoutableStep): number {
  const stepKinds = new Set(
    (step.requiredPermissions ?? []).map((p) => p.kind),
  );
  let extra = 0;
  for (const req of capability.requiredPermissions) {
    if (!stepKinds.has(req.kind)) {
      extra += 1;
    }
  }
  // Fewer unrequested privileges => better fit. Negate so higher is better.
  return -extra;
}

/**
 * Whether every permission the step exercises is satisfiable for the subject
 * under its active profile. "Satisfiable" means the subject either already
 * holds a grant that allows the requirement outright, or holds one that permits
 * it behind an approval — both are routable; a requirement the subject can
 * neither perform nor be approved for makes the candidate ineligible.
 */
function permissionsSatisfiable(
  permissions: PermissionService,
  subject: PermissionSubject,
  step: RoutableStep,
): boolean {
  const required = step.requiredPermissions ?? [];
  return required.every(
    (req) =>
      permissions.allows(subject, req) ||
      permissions.requiresApproval(subject, req),
  );
}

/**
 * Count of the step's permissions the subject can satisfy without any approval
 * for this candidate. Used only as a late precedence tiebreaker ("prefer the
 * route that needs the fewest approvals"). Higher is better.
 */
function outrightAllowedCount(
  permissions: PermissionService,
  subject: PermissionSubject,
  step: RoutableStep,
): number {
  const required = step.requiredPermissions ?? [];
  let count = 0;
  for (const req of required) {
    if (permissions.allows(subject, req)) {
      count += 1;
    }
  }
  return count;
}

/** A candidate paired with the precedence keys used to order it. */
interface ScoredCandidate {
  readonly record: AdapterRecord;
  readonly fit: number; // higher better
  readonly cost: number; // lower better
  readonly latency: number; // lower better
  readonly permissionScore: number; // higher better
  readonly history: number; // higher better
  readonly preference: number; // lower better
}

/**
 * Total ordering over scored candidates implementing the fixed precedence of
 * Requirement 6.6: task fit, then availability (already filtered, so equal
 * here), then cost, latency, permissions, historical performance, the shared
 * agent preference order, and finally a stable lexicographic tiebreaker on
 * adapter id. Returns negative when `a` should be preferred (sorts earlier),
 * positive when `b` should be.
 */
function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.fit !== b.fit) return b.fit - a.fit; // higher fit first
  if (a.cost !== b.cost) return a.cost - b.cost; // lower cost first
  if (a.latency !== b.latency) return a.latency - b.latency; // lower latency first
  if (a.permissionScore !== b.permissionScore) {
    return b.permissionScore - a.permissionScore; // more outright-allowed first
  }
  if (a.history !== b.history) return b.history - a.history; // better history first
  if (a.preference !== b.preference) return a.preference - b.preference; // preferred agent first
  // Stable, deterministic final tiebreaker: lexicographic adapter id.
  return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
}

/**
 * Deterministically route every step to exactly one adapter, a deterministic
 * fallback, or BLOCKED. Pure function of its inputs: identical inputs always
 * produce an identical result (Requirement 6.6).
 */
export function selectAdapters(
  input: SelectAdaptersInput,
): RoutingDecision[] {
  const {
    steps,
    registry,
    permissions,
    subject,
    historicalPerformance,
    fallbackAutomations,
  } = input;

  return steps.map((step) =>
    routeStep(
      step,
      registry,
      permissions,
      subject,
      historicalPerformance,
      fallbackAutomations,
    ),
  );
}

function routeStep(
  step: RoutableStep,
  registry: Registry,
  permissions: PermissionService,
  subject: PermissionSubject,
  historicalPerformance: HistoricalPerformance | undefined,
  fallbackAutomations: FallbackAutomations | undefined,
): RoutingDecision {
  const declaring = registry.adaptersSupporting(step.requiredCapability);

  if (declaring.length === 0) {
    return unroutable(step, 'no_candidates', fallbackAutomations);
  }

  const available = declaring.filter((record) => record.available);
  if (available.length === 0) {
    return unroutable(step, 'none_available', fallbackAutomations);
  }

  const eligible = available.filter((record) => {
    // The declared capability is guaranteed present (that is why the Registry
    // returned this record), but guard defensively and skip if absent.
    if (findCapability(record, step.requiredCapability) === undefined) {
      return false;
    }
    const capability = findCapability(record, step.requiredCapability)!;
    return permissionsSatisfiable(permissions, subject, {
      ...step, requiredPermissions: [...(step.requiredPermissions ?? []), ...capability.requiredPermissions],
    });
  });

  if (eligible.length === 0) {
    return unroutable(step, 'permissions_unsatisfiable', fallbackAutomations);
  }

  const scored: ScoredCandidate[] = eligible.map((record) => {
    // Non-null: capability presence was verified in the eligibility filter.
    const capability = findCapability(record, step.requiredCapability)!;
    return {
      record,
      fit: taskFit(capability, step),
      cost: rankHint(capability.costHint),
      latency: rankHint(capability.latencyHint),
      permissionScore: outrightAllowedCount(permissions, subject, step),
      history:
        historicalPerformance === undefined
          ? 0
          : historicalPerformance(record.id, step.requiredCapability),
      preference: agentPreferenceRank(record.id),
    };
  });

  // Sort a copy with the total-order comparator and take the single winner.
  // The comparator's id tiebreaker guarantees a unique, stable argmax.
  const winner = [...scored].sort(compareCandidates)[0]!;

  return {
    stepId: step.id,
    requiredCapability: step.requiredCapability,
    kind: 'assigned',
    assignedAdapterId: winner.record.id,
  };
}

function unroutable(
  step: RoutableStep,
  reason: RoutingUnroutableReason,
  fallbackAutomations: FallbackAutomations | undefined,
): RoutingDecision {
  const fallbackId = fallbackAutomations?.get(step.requiredCapability);
  if (fallbackId !== undefined) {
    return {
      stepId: step.id,
      requiredCapability: step.requiredCapability,
      kind: 'fallback',
      fallbackAutomationId: fallbackId,
      reason,
    };
  }
  return {
    stepId: step.id,
    requiredCapability: step.requiredCapability,
    kind: 'blocked',
    reason,
  };
}
