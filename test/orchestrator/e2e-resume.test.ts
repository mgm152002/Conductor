import { TaskRunner } from '@main/orchestrator/task-runner';
import { TaskQueries } from '@main/orchestrator/task-queries';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { Registry } from '@main/registry/registry';
import { PermissionService } from '@main/domain/permission-service';
import { SettingsService } from '@main/domain/settings-service';
import { DataControlService } from '@main/domain/data-control-service';
import { WorkspaceService } from '@main/domain/workspace-service';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import { Orchestrator } from '@main/orchestrator/orchestrator';
import { ResumeCenter } from '@main/orchestrator/resume-center';
import { ResumeService } from '@main/orchestrator/resume-service';
import { RecordingTaskEventEmitter } from '@main/orchestrator/event-emitter';
import { IpcRouter } from '@main/ipc/router';
import { registerDomainHandlers } from '@main/ipc/register-domain';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import type {
  Planner,
  PlanDecomposition,
  PlanRequest,
} from '@main/orchestrator/planner';
import type {
  CriterionEvaluator,
  EvaluateCriterionInput,
} from '@main/orchestrator/verifier';
import type { StepPermissions } from '@main/orchestrator/step-executor';
import { FakeAdapter, type FakeAdapterScript } from '../fakes/fake-adapter';
import type { CapabilityDescriptor } from '@shared/adapter';
import type {
  IpcResult,
  IpcSuccess,
  InvokeChannel,
} from '@shared/ipc-contract';
import type {
  ResumeSnapshot,
  Task,
  TaskState,
  TaskStep,
  TaskStepStatus,
} from '@shared/domain';
import type { UsageSummary } from '@shared/usage';

// Task 11.4 — the end-to-end integration test for the M1–M3 vertical slice.
//
// This is the one test that drives the WHOLE lifecycle in order, the way the
// renderer and a crash-then-relaunch actually would, rather than exercising one
// seam in isolation:
//
//   IPC (task.create through the validated router)
//     → orchestrator (CONTEXT_LOADING → PLANNING → routed DAG)
//     → RUNNING step execution with a streamed adapter and per-event checkpoints
//     → an approval gate (WAITING_FOR_APPROVAL) on a consequential step
//     → a crash injected MID-STEP (the adapter dies partway through its stream)
//     → "relaunch": a brand-new orchestrator + ResumeCenter over the SAME store
//        (durability is what makes the slice survive the crash)
//     → onBoot() reconciliation reconstructing the correct classification from
//        the last persisted checkpoint
//     → idempotent resume (the already-succeeded step is never re-run)
//     → VERIFYING, where verification — NOT an adapter exit code of 0 — is the
//        sole gate on COMPLETED.
//
// Driving the REAL local CLI adapter from a test would require a specific CLI on
// PATH and a controllable crash, which is not portable in CI; per the task we
// instead use the FakeAdapter with realistic scripted streams and an injected
// mid-step crash, while still exercising the full
// IPC → orchestrator → verify → crash → resume path end to end.
//
// Validates: Requirements 8.1, 8.6, 7.2, 7.3; Property 2, Property 3, Property 4.

// ---- Capabilities the two-step plan routes against ----

const BENIGN_CAP = 'e2e.benign';
const CONSEQUENTIAL_CAP = 'e2e.consequential';

function capability(id: string): CapabilityDescriptor {
  return {
    id,
    title: `Capability ${id}`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    streaming: true,
    cancellable: true,
    resumable: true,
    requiredPermissions: [],
  };
}

// ---- A deterministic two-step planner ----
//
// step-1 (benign)       → runs freely, streams events, succeeds.
// step-2 (consequential) → depends on step-1, declares a `destructive`
//                          permission so it is gated through
//                          WAITING_FOR_APPROVAL; it is where the crash lands.

class TwoStepPlanner implements Planner {
  decompose(_request: PlanRequest): Promise<PlanDecomposition> {
    return Promise.resolve({
      steps: [
        {
          id: 'step-1',
          description: 'benign preparatory step',
          requiredCapability: BENIGN_CAP,
        },
        {
          id: 'step-2',
          description: 'consequential destructive step',
          requiredCapability: CONSEQUENTIAL_CAP,
          requiredPermissions: [{ kind: 'destructive' }],
          dependsOn: ['step-1'],
        },
      ],
    });
  }
}

// The step-permissions resolver the executor / resume service consult: the
// consequential step (step-2) declares a destructive permission, everything
// else declares none. Keyed by description since that is what survives on the
// persisted step row.
const stepPermissions: StepPermissions = (step: TaskStep) =>
  step.description.includes('consequential') ? [{ kind: 'destructive' }] : [];

// ---- A fake ipcMain that records handlers so the test can invoke channels ----
//
// The real IpcRouter registers handlers on `ipcMain.handle(channel, fn)`. This
// captures them so the test can call a channel exactly as the preload bridge
// would (payload in, IpcResult out), exercising the validated router for real.

type RegisteredHandler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

class FakeIpcMain {
  private readonly handlers = new Map<string, RegisteredHandler>();

  handle(channel: string, fn: RegisteredHandler): void {
    this.handlers.set(channel, fn);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  /** Invoke a channel the way the renderer would; returns the IpcResult. */
  async invoke<T>(channel: InvokeChannel, payload?: unknown): Promise<IpcResult<T>> {
    const fn = this.handlers.get(channel);
    if (fn === undefined) {
      throw new Error(`No handler registered for channel ${channel}`);
    }
    return (await fn({}, payload)) as IpcResult<T>;
  }
}

/** Assert an IpcResult succeeded and return its value. */
function expectOk<T>(result: IpcResult<T>): T {
  expect(result.ok).toBe(true);
  return (result as IpcSuccess<T>).value;
}

// ---- Shared fixtures ----

let store: SqliteStore;
let audit: AuditLog;
let workspaces: WorkspaceService;
let permissions: PermissionService;
let tmpRoot: string;
let blobRoot: string;
let workspaceId: string;

/** A registry with the two adapters the two-step plan routes against. */
function buildRegistry(opts: {
  benign?: FakeAdapterScript;
  consequential?: FakeAdapterScript;
}): { registry: Registry; benign: FakeAdapter; consequential: FakeAdapter } {
  const benign = new FakeAdapter({
    record: {
      id: 'benign-adapter',
      name: 'Benign',
      capabilities: [capability(BENIGN_CAP)],
    },
    ...(opts.benign !== undefined ? { script: opts.benign } : {}),
  });
  const consequential = new FakeAdapter({
    record: {
      id: 'consequential-adapter',
      name: 'Consequential',
      capabilities: [capability(CONSEQUENTIAL_CAP)],
    },
    ...(opts.consequential !== undefined ? { script: opts.consequential } : {}),
  });
  const registry = new Registry();
  registry.register(benign);
  registry.register(consequential);
  return { registry, benign, consequential };
}

interface Harness {
  runner: TaskRunner;
  orchestrator: Orchestrator;
  resumeCenter: ResumeCenter;
  resumeService: ResumeService;
  canceller: TaskCanceller;
  emitter: RecordingTaskEventEmitter;
  ipcMain: FakeIpcMain;
  registry: Registry;
  benign: FakeAdapter;
  consequential: FakeAdapter;
}

/**
 * Compose a full "launch" of the main-process orchestration stack over the
 * shared store, wired onto a validated IPC router. Every launch is independent
 * (fresh in-memory services) but shares the durable `store`, so a second launch
 * models relaunch-after-crash: all task/step/checkpoint/session state is
 * reloaded from SQLite, nothing from the previous launch's memory.
 */
function launch(opts: {
  registry: Registry;
  benign: FakeAdapter;
  consequential: FakeAdapter;
  storage?: DiskManagedStorage;
  evaluator?: CriterionEvaluator;
  refreshUsageLimits?: () => Promise<void>;
  usageSummary?: () => UsageSummary;
}): Harness {
  const stateMachine = new TaskStateMachine(store, audit);
  const emitter = new RecordingTaskEventEmitter();
  const canceller = new TaskCanceller(store, stateMachine, opts.registry, audit);
  const orchestrator = new Orchestrator(
    store,
    stateMachine,
    workspaces,
    canceller,
    audit,
    {
      registry: opts.registry,
      permissions,
      planner: new TwoStepPlanner(),
      emitter,
      stepPermissions,
      // Immediate backoff so bounded retries never add real delay.
      backoffClock: { sleep: () => Promise.resolve() },
      ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
      ...(opts.evaluator !== undefined ? { criterionEvaluator: opts.evaluator } : {}),
    },
  );
  const resumeCenter = new ResumeCenter(
    store,
    stateMachine,
    opts.registry,
    audit,
    opts.storage !== undefined ? { storage: opts.storage } : {},
  );
  const resumeService = new ResumeService(
    store,
    stateMachine,
    orchestrator,
    canceller,
    audit,
    { stepPermissions, emitter },
  );

  const ipcMain = new FakeIpcMain();
  const router = new IpcRouter({ ipcMain: ipcMain as never });
  const settings = new SettingsService(store, workspaces);
  const runner = new TaskRunner({store,orchestrator,stateMachine,permissions,registry:opts.registry,audit,emitter});
  registerDomainHandlers({
    router, store, permissions, registry:opts.registry, audit, runner,
    taskQueries:new TaskQueries(store,orchestrator,permissions,opts.storage ?? new DiskManagedStorage(join(process.cwd(),'node_modules/.tmp/query-blobs'))),
    workspaces,
    settings,
    orchestrator,
    resumeCenter,
    resumeService,
    cliCatalog: { list: () => [], rescan: () => [] } as never,
    dataControl: new DataControlService(store, settings, audit),
    ...(opts.refreshUsageLimits !== undefined ? { refreshUsageLimits: opts.refreshUsageLimits } : {}),
    ...(opts.usageSummary !== undefined ? { usageSummary: opts.usageSummary } : {}),
  });

  return {
    runner,
    orchestrator,
    resumeCenter,
    resumeService,
    canceller,
    emitter,
    ipcMain,
    registry: opts.registry,
    benign: opts.benign,
    consequential: opts.consequential,
  };
}

function emptyUsageSummary(): UsageSummary {
  const totals = {
    key: 'all', label: 'All agents', sessions: 0, inputTokens: 0, cachedInputTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
  };
  return { range: '7d', totals, byAgent: [], byProject: [], byModel: [], clients: [] };
}

// ---- Durable read helpers (read straight from SQLite, not any memory cache) ----

function taskState(taskId: string): TaskState {
  return (
    store.db.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as {
      state: TaskState;
    }
  ).state;
}

function stepStatuses(taskId: string): TaskStepStatus[] {
  const rows = store.db
    .prepare(
      'SELECT status FROM task_steps WHERE task_id = ? ORDER BY ordinal ASC',
    )
    .all(taskId) as { status: TaskStepStatus }[];
  return rows.map((r) => r.status);
}

function streamEventCount(taskId: string): number {
  return (
    store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'stream'`,
      )
      .get(taskId) as { n: number }
  ).n;
}

function pendingApprovalId(taskId: string): string {
  const pending = permissions.pendingApprovals(taskId);
  expect(pending.length).toBe(1);
  return pending[0]!.id;
}

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
  audit = new AuditLog(store);
  workspaces = new WorkspaceService(store);
  permissions = new PermissionService(store, audit);
  tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-e2e-ws-'));
  blobRoot = mkdtempSync(join(tmpdir(), 'conductor-e2e-blob-'));
  workspaceId = workspaces.create({ name: 'E2E', rootPath: tmpRoot }).id;

  // Grant the orchestrator agent assisted_execution so a destructive step is
  // PERMITTED but gated behind an approval (never allowed outright). This is
  // what makes the consequential step suspend in WAITING_FOR_APPROVAL rather
  // than being rejected at routing time.
  permissions.grant({
    subject: { type: 'agent', id: 'orchestrator' },
    profile: 'assisted_execution',
  });
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(blobRoot, { recursive: true, force: true });
});

describe('E2E: IPC → stream → approval → crash → relaunch → resume → verify', () => {
  it('reconstructs the checkpoint on relaunch and gates COMPLETED on verification, not exit code', async () => {
    const storage = new DiskManagedStorage(blobRoot);

    // ---- Launch #1: create via IPC and drive to the approval gate --------
    //
    // The benign step streams two events then succeeds. The consequential step
    // is where a crash will later land; on this first launch it never runs —
    // execution suspends at the approval gate before step-2 starts.
    const built = buildRegistry({
      benign: {
        events: [
          { kind: 'log', data: 'preparing' },
          { kind: 'log', data: 'prepared' },
        ],
        result: { status: 'succeeded', exitCode: 0 },
      },
      // step-2 will crash MID-STREAM: it emits one event then the adapter dies.
      consequential: {
        events: [{ kind: 'log', data: 'mutating...' }],
        crashAt: 'stream',
        crashMessage: 'app killed mid-step',
      },
    });

    let h = launch({ ...built, storage });

    // Create the task THROUGH the validated IPC router, exactly as the renderer
    // would. The application driver advances it until the approval gate.
    const created = expectOk(
      await h.ipcMain.invoke<Task>('task.create', {
        workspaceId,
        objective: 'migrate the database and delete the old table',
      }),
    );
    expect(created.state).toBe('CREATED');
    const taskId = created.id;

    // The real IPC driver advances planning and execution, then suspends on approval.
    await h.runner.waitForIdle(taskId);
    expect(taskState(taskId)).toBe('WAITING_FOR_APPROVAL');

    // The benign step really streamed and checkpointed per event (Req 8.1
    // durability substrate): two stream events persisted, benign succeeded,
    // consequential still pending and never started.
    expect(h.benign.calls.started.length).toBe(1);
    expect(h.consequential.calls.started.length).toBe(0);
    expect(streamEventCount(taskId)).toBe(2);
    expect(stepStatuses(taskId)).toEqual(['succeeded', 'pending']);
    // The renderer saw live progress (task.stream emissions within the loop).
    expect(h.emitter.payloadsFor('task.stream').length).toBe(2);

    // Approve the gate via the Permission_Service (the approval.resolve IPC
    // path lives in a sibling slice; the durable approval state is what the
    // executor consults on resume).
    const approvalId = pendingApprovalId(taskId);
    const decision = permissions.approve(approvalId);
    expect(decision.resolved).toBe(true);
    // The subject now holds the destructive permission outright for resume, so
    // the consequential step is no longer gated and can run (then crash).
    permissions.grant({
      subject: { type: 'agent', id: 'orchestrator' },
      profile: 'trusted_automation',
    });

    // Move the approved task onto the RUNNING path and drive step-2, which
    // crashes mid-stream. The crash is swallowed into a failed step (its
    // retries exhaust), but the ALREADY-STREAMED event + checkpoint are durable.
    const sm1 = new TaskStateMachine(store, audit);
    sm1.transition({ taskId, to: 'RUNNING', eventPayload: { reason: 'approved' } });
    const streamEventsBeforeCrash = streamEventCount(taskId);
    await h.orchestrator.runSteps(taskId);

    // The crash drove step-2 through its bounded retries. The adapter died at
    // the START of its stream (a hard mid-step kill), so step-2 streamed no new
    // events — but each attempt DID start a session and the crash was recorded
    // as a durable kind='error' task_event, and the benign step's success was
    // never undone. Durability (Req 8.1) is what survives: step-1's two stream
    // events + checkpoints are still on disk.
    expect(h.consequential.calls.started.length).toBeGreaterThanOrEqual(1);
    expect(streamEventCount(taskId)).toBe(streamEventsBeforeCrash); // no new stream events
    const errorEvents = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'error'`,
        )
        .get(taskId) as { n: number }
    ).n;
    expect(errorEvents).toBeGreaterThanOrEqual(1);
    // step-1 is still succeeded — the crash never touched it.
    expect(stepStatuses(taskId)[0]).toBe('succeeded');

    // Simulate the app being killed mid-step: leave a session row marked live
    // (as a hard kill would, with no graceful exit) so boot reconciliation has
    // to reconcile it against reality rather than trusting the stale status.
    store.db
      .prepare(
        `UPDATE agent_sessions SET status = 'live'
          WHERE task_id = ? AND adapter_id = 'consequential-adapter'`,
      )
      .run(taskId);
    // And force the task back to a mid-flight non-terminal state as a hard kill
    // would leave it (execution did not get to write a terminal transition).
    const killSm = new TaskStateMachine(store, audit);
    const midState = taskState(taskId);
    if (midState === 'VERIFYING') {
      // step-2 failed → executor moved to VERIFYING; a kill before verification
      // leaves it recoverable.
      killSm.transition({
        taskId,
        to: 'RECOVERABLE_INTERRUPTION',
        eventPayload: { reason: 'crash' },
      });
    }

    // ---- RELAUNCH: fresh stack over the SAME durable store ---------------
    //
    // Nothing from launch #1's memory carries over. The consequential adapter
    // is now healthy (the "app" restarted cleanly) and its sessions are dead.
    const relaunched = buildRegistry({
      // Every session from launch #1 is dead after a hard kill — both adapters
      // probe their prior sessions as not-live on boot.
      benign: { result: { status: 'succeeded' }, livenessDefault: false },
      consequential: {
        events: [{ kind: 'log', data: 'mutated' }],
        result: { status: 'succeeded', exitCode: 0 },
        // Dead sessions on boot: the killed process is gone.
        livenessDefault: false,
      },
    });
    h = launch({ ...relaunched, storage });

    // onBoot() reconciles every non-terminal task against reality and
    // classifies deterministically (Property 2). The killed task reconstructs
    // from its last checkpoint — its dead session makes it recoverable, not
    // "succeeded" (an exit code is never promoted here).
    const snapshot: ResumeSnapshot = await h.resumeCenter.onBoot();
    const item = snapshot.items.find((i) => i.taskId === taskId);
    expect(item).toBeDefined();
    expect(item!.classification).toBe('RECOVERABLE_INTERRUPTION');
    expect(taskState(taskId)).toBe('RECOVERABLE_INTERRUPTION');

    // Determinism (Property 2): a second onBoot over unchanged inputs yields the
    // same classification.
    const snapshot2 = await h.resumeCenter.onBoot();
    const item2 = snapshot2.items.find((i) => i.taskId === taskId);
    expect(item2!.classification).toBe(item!.classification);

    // The resume.snapshot IPC channel serves the reconciled snapshot the UI
    // renders (Requirement 8.6 — the Resume Center presents the reconciled task).
    const servedSnapshot = expectOk(
      await h.ipcMain.invoke<ResumeSnapshot>('resume.snapshot'),
    );
    expect(servedSnapshot.items.some((i) => i.taskId === taskId)).toBe(true);

    // ---- RESUME through the Resume Center (idempotent) -------------------
    //
    // Resuming re-executes step-2 (it never succeeded) but NEVER step-1
    // (Property 4). The resume re-runs a consequential step, so it requires
    // explicit confirmation (Requirement 8.7): an unconfirmed resume refuses.
    const unconfirmed = expectOk(
      await h.ipcMain.invoke<{ status: string; confirmationReason?: string }>(
        'resume.act',
        { taskId, action: 'resume' },
      ),
    );
    expect(unconfirmed.status).toBe('confirmation_required');
    expect(unconfirmed.confirmationReason).toBe('consequential');
    // Nothing changed — still interrupted, step-1 still succeeded, step-2 is the
    // crashed (failed) step awaiting re-execution. The resume gate keys off "not
    // succeeded", so a failed step is still a candidate for a confirmed resume.
    expect(taskState(taskId)).toBe('RECOVERABLE_INTERRUPTION');
    expect(stepStatuses(taskId)).toEqual(['succeeded', 'failed']);

    // Confirm the resume. step-1 is skipped; the healthy consequential adapter
    // runs step-2 to success; the task reaches VERIFYING.
    const resumed = expectOk(
      await h.ipcMain.invoke<{ status: string; state: TaskState }>('resume.act', {
        taskId,
        action: 'resume',
        confirmed: true,
      }),
    );
    expect(resumed.status).toBe('applied');
    expect(resumed.state).toBe('VERIFYING');
    // step-1 was NOT re-run on resume (Property 4): the benign adapter in the
    // relaunched stack was never started.
    expect(h.benign.calls.started.length).toBe(0);
    // step-2 DID run on the relaunched consequential adapter — once, succeeding
    // on its first attempt with no retries.
    expect(h.consequential.calls.started.length).toBe(1);
    expect(stepStatuses(taskId)).toEqual(['succeeded', 'succeeded']);

    // The application driver now completes the verification pass automatically.
    // Clean adapter exits still cannot satisfy the conservative evidence evaluator.
    await h.runner.waitForIdle(taskId);
    expect(taskState(taskId)).toBe('FAILED');
    expect(h.orchestrator.getTask(taskId)?.lastVerifiedCheckpointId).toBeUndefined();

  });

  it('completes only when verification passes every criterion (Property 3 positive case)', async () => {
    const storage = new DiskManagedStorage(blobRoot);

    // A clean run with NO approval gate (grant trusted_automation so the
    // destructive step runs without suspending) and both steps succeeding.
    permissions.grant({
      subject: { type: 'agent', id: 'orchestrator' },
      profile: 'trusted_automation',
    });

    const built = buildRegistry({
      benign: {
        events: [{ kind: 'log', data: 'ok' }],
        result: { status: 'succeeded', exitCode: 0 },
      },
      consequential: {
        events: [{ kind: 'log', data: 'ok' }],
        result: { status: 'succeeded', exitCode: 0 },
      },
    });

    // A passing evaluator: verification confirms the one acceptance criterion.
    const passing: CriterionEvaluator = (input: EvaluateCriterionInput) => ({
      criterion: input.criterion,
      index: input.index,
      satisfied: true,
    });

    const h = launch({ ...built, storage, evaluator: passing });

    const created = expectOk(
      await h.ipcMain.invoke<Task>('task.create', {
        workspaceId,
        objective: 'do the clean two-step thing',
      }),
    );
    const taskId = created.id;

    await h.runner.waitForIdle(taskId);
    expect(stepStatuses(taskId)).toEqual(['succeeded', 'succeeded']);
    expect(taskState(taskId)).toBe('COMPLETED');
    const verify = {verifiedCheckpointId:h.orchestrator.getTask(taskId)!.lastVerifiedCheckpointId};
    // A VERIFIED checkpoint referencing the verification outcome was written
    // (Requirement 7.2, 7.6).
    expect(verify.verifiedCheckpointId).toBeDefined();
    const verifiedCheckpoint = store.db
      .prepare('SELECT verified FROM checkpoints WHERE id = ?')
      .get(verify.verifiedCheckpointId) as { verified: number };
    expect(verifiedCheckpoint.verified).toBe(1);
  });
});

describe('Usage summary quota refresh', () => {
  it('awaits quota refresh before reading the usage summary', async () => {
    const order: string[] = [];
    const built = buildRegistry({});
    const h = launch({
      ...built,
      refreshUsageLimits: async () => {
        await Promise.resolve();
        order.push('refresh');
      },
      usageSummary: () => {
        order.push('summary');
        return emptyUsageSummary();
      },
    });

    const result = expectOk(await h.ipcMain.invoke<UsageSummary>('usage.summary', { range: '7d', refreshLimits: true }));

    expect(order).toEqual(['refresh', 'summary']);
    expect(result.range).toBe('7d');
  });

  it('reads stored limits without probing CLIs on an ordinary load', async () => {
    let refreshes = 0;
    const built = buildRegistry({});
    const h = launch({
      ...built,
      refreshUsageLimits: async () => {
        refreshes += 1;
      },
      usageSummary: emptyUsageSummary,
    });

    const result = expectOk(await h.ipcMain.invoke<UsageSummary>('usage.summary', { range: '7d' }));

    expect(refreshes).toBe(0);
    expect(result).toEqual(emptyUsageSummary());
  });

  it('returns the stored summary when quota refresh fails', async () => {
    let refreshes = 0;
    const built = buildRegistry({});
    const h = launch({
      ...built,
      refreshUsageLimits: async () => {
        refreshes += 1;
        throw new Error('provider unavailable');
      },
      usageSummary: emptyUsageSummary,
    });

    const result = expectOk(await h.ipcMain.invoke<UsageSummary>('usage.summary', { range: '7d', refreshLimits: true }));

    expect(refreshes).toBe(1);
    expect(result).toEqual(emptyUsageSummary());
  });
});
