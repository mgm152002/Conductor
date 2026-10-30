import type { Migration, Tx } from '../types';

// Migration 1 — M1 foundation: workspaces, preferences, the singleton
// active-workspace pointer, and the immutable audit log. Later milestones add
// tasks/steps/checkpoints/events/sessions (task 8) as migration 2+.

const migration001: Migration = {
  version: 1,
  name: 'init_workspaces_preferences_audit',
  up(tx: Tx): void {
    const { db } = tx;

    db.exec(`
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        root_path   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_workspaces_created_at ON workspaces (created_at);
    `);

    // Preferences: one row per (scope, workspace_id, key). Global rows store
    // workspace_id = '' so the UNIQUE constraint behaves with NOT NULL columns.
    db.exec(`
      CREATE TABLE preferences (
        scope         TEXT NOT NULL CHECK (scope IN ('global', 'workspace')),
        workspace_id  TEXT NOT NULL DEFAULT '',
        key           TEXT NOT NULL,
        value_json    TEXT NOT NULL,
        PRIMARY KEY (scope, workspace_id, key)
      );
    `);

    // Singleton pointer to the active workspace; id column pinned to 1.
    db.exec(`
      CREATE TABLE active_workspace (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        workspace_id  TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE SET NULL
      );
      INSERT INTO active_workspace (id, workspace_id) VALUES (1, NULL);
    `);

    // Append-only audit log. No UPDATE/DELETE paths exist in code; immutability
    // is enforced by discipline plus the lack of mutating statements.
    db.exec(`
      CREATE TABLE audit_events (
        id               TEXT PRIMARY KEY NOT NULL,
        actor            TEXT NOT NULL,
        action           TEXT NOT NULL,
        target           TEXT,
        redacted_payload TEXT NOT NULL,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX idx_audit_events_created_at ON audit_events (created_at);
    `);
  },
};

// Migration 2 — M1/M3 permissions & approvals: per-agent / per-workflow
// permission grants (scoped and revocable) and the Approval_Request lifecycle
// (pending/approved/denied/expired). The immutable audit log itself lives in
// migration 1; this migration adds the state the Permission_Service persists.

const migration002: Migration = {
  version: 2,
  name: 'permissions_and_approvals',
  up(tx: Tx): void {
    const { db } = tx;

    // A permission grant binds a (profile) to a subject — an agent (adapterId)
    // or a workflow (workflowId) — optionally narrowed to a requirement kind
    // and scope. Revocation is a soft, timestamped operation so the audit
    // trail and the "block subsequent dependent actions" check both survive:
    // a revoked grant stays in the table with revoked_at set.
    db.exec(`
      CREATE TABLE permission_grants (
        id              TEXT PRIMARY KEY NOT NULL,
        subject_type    TEXT NOT NULL CHECK (subject_type IN ('agent', 'workflow')),
        subject_id      TEXT NOT NULL,
        profile         TEXT NOT NULL CHECK (profile IN ('read_only', 'assisted_execution', 'trusted_automation')),
        requirement_kind TEXT,
        scope           TEXT,
        granted_at      TEXT NOT NULL,
        revoked_at      TEXT
      );
      CREATE INDEX idx_permission_grants_subject
        ON permission_grants (subject_type, subject_id);
    `);

    // Approval requests. status transitions pending -> approved|denied|expired.
    // subject_type/subject_id link the request to the agent or workflow whose
    // permission is being exercised, so a revocation can cancel dependent
    // in-flight (pending) requests.
    db.exec(`
      CREATE TABLE approval_requests (
        id              TEXT PRIMARY KEY NOT NULL,
        task_id         TEXT NOT NULL,
        step_id         TEXT,
        subject_type    TEXT NOT NULL CHECK (subject_type IN ('agent', 'workflow')),
        subject_id      TEXT NOT NULL,
        summary         TEXT NOT NULL,
        requirements    TEXT NOT NULL,
        status          TEXT NOT NULL
                          CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        resolved_at     TEXT
      );
      CREATE INDEX idx_approval_requests_task ON approval_requests (task_id);
      CREATE INDEX idx_approval_requests_status ON approval_requests (status);
      CREATE INDEX idx_approval_requests_subject
        ON approval_requests (subject_type, subject_id);
    `);
  },
};

// Migration 3 — M3 orchestrator core: the durable task state machine. Adds the
// five tables the Orchestrator writes through its write-ahead transition
// primitive: tasks (the canonical state), task_steps (the intra-task DAG),
// checkpoints (minimal resumable snapshots with a verified flag), task_events
// (the append-only transition/stream/log/artifact/approval/error stream), and
// agent_sessions (live adapter/CLI/remote handles the Resume Center probes).
//
// JSON-encoded array/object columns (acceptance_criteria, context_refs,
// depends_on, snapshot, payload) are stored as TEXT; the repositories own the
// serialization. exit_code is deliberately nullable and is never treated as a
// success signal by itself (Property 3).

const migration003: Migration = {
  version: 3,
  name: 'tasks_steps_checkpoints_events_sessions',
  up(tx: Tx): void {
    const { db } = tx;

    // tasks — the canonical durable state of the state machine. `state` is
    // constrained to the exactly 11 Task_States. last_verified_checkpoint_id
    // references the checkpoint that independently confirmed verification.
    db.exec(`
      CREATE TABLE tasks (
        id                          TEXT PRIMARY KEY NOT NULL,
        workspace_id                TEXT NOT NULL,
        objective                   TEXT NOT NULL,
        acceptance_criteria         TEXT NOT NULL DEFAULT '[]',
        state                       TEXT NOT NULL CHECK (state IN (
                                      'CREATED', 'CONTEXT_LOADING', 'PLANNING',
                                      'WAITING_FOR_APPROVAL', 'RUNNING', 'VERIFYING',
                                      'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED',
                                      'RECOVERABLE_INTERRUPTION')),
        context_refs                TEXT NOT NULL DEFAULT '[]',
        recommended_next_action     TEXT,
        last_verified_checkpoint_id TEXT,
        created_at                  TEXT NOT NULL,
        updated_at                  TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_tasks_workspace ON tasks (workspace_id);
      CREATE INDEX idx_tasks_state ON tasks (state);
    `);

    // task_steps — the intra-task DAG. depends_on is a JSON array of step ids.
    db.exec(`
      CREATE TABLE task_steps (
        id                  TEXT PRIMARY KEY NOT NULL,
        task_id             TEXT NOT NULL,
        ordinal             INTEGER NOT NULL,
        description         TEXT NOT NULL,
        depends_on          TEXT NOT NULL DEFAULT '[]',
        assigned_adapter_id TEXT,
        input_schema_ref    TEXT,
        status              TEXT NOT NULL CHECK (status IN (
                              'pending', 'running', 'succeeded',
                              'failed', 'skipped', 'cancelled')),
        started_at          TEXT,
        ended_at            TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_task_steps_task ON task_steps (task_id, ordinal);
    `);

    // checkpoints — minimal resumable snapshots. `verified` is the only thing
    // that lets VERIFYING reach COMPLETED; snapshot is JSON.
    db.exec(`
      CREATE TABLE checkpoints (
        id          TEXT PRIMARY KEY NOT NULL,
        task_id     TEXT NOT NULL,
        step_id     TEXT,
        state       TEXT NOT NULL CHECK (state IN (
                      'CREATED', 'CONTEXT_LOADING', 'PLANNING',
                      'WAITING_FOR_APPROVAL', 'RUNNING', 'VERIFYING',
                      'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED',
                      'RECOVERABLE_INTERRUPTION')),
        snapshot    TEXT NOT NULL,
        verified    INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
        created_at  TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
        FOREIGN KEY (step_id) REFERENCES task_steps (id) ON DELETE SET NULL
      );
      CREATE INDEX idx_checkpoints_task ON checkpoints (task_id, created_at);
    `);

    // task_events — the append-only event stream. The write-ahead transition
    // primitive inserts a kind='transition' row in the same transaction as the
    // state + checkpoint update. No UPDATE/DELETE code path exists.
    db.exec(`
      CREATE TABLE task_events (
        id          TEXT PRIMARY KEY NOT NULL,
        task_id     TEXT NOT NULL,
        step_id     TEXT,
        kind        TEXT NOT NULL CHECK (kind IN (
                      'transition', 'log', 'artifact',
                      'approval', 'error', 'stream')),
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
        FOREIGN KEY (step_id) REFERENCES task_steps (id) ON DELETE SET NULL
      );
      CREATE INDEX idx_task_events_task ON task_events (task_id, created_at);
    `);

    // agent_sessions — live adapter/CLI/remote handles. exit_code is nullable
    // and is NOT a success signal by itself (Property 3). The Resume Center
    // probes liveness and updates status on boot.
    db.exec(`
      CREATE TABLE agent_sessions (
        id                 TEXT PRIMARY KEY NOT NULL,
        task_id            TEXT NOT NULL,
        adapter_id         TEXT NOT NULL,
        external_ref       TEXT,
        status             TEXT NOT NULL CHECK (status IN (
                             'starting', 'live', 'exited',
                             'orphaned', 'unknown')),
        resumable          INTEGER NOT NULL DEFAULT 0 CHECK (resumable IN (0, 1)),
        last_heartbeat_at  TEXT,
        exit_code          INTEGER,
        created_at         TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_agent_sessions_task ON agent_sessions (task_id);
    `);
  },
};

// Migration 4 — M4 context engine: the structured, source-linked model of
// active work (Requirement 12). A context item lives at exactly one scope
// (global/project/task/workflow/source), carries a veracity classification
// (observed_fact/inferred/unverified_assumption), a confidence clamped to
// [0, 1], and timestamps. Its provenance sources are a separate child table so
// each item can link to one or more sources (Requirement 12.1/12.2); the
// Context_Engine enforces the "at least one provenance" invariant in code.
//
// scope_ref_id is nullable because a global-scope item has no referent.
// confidence is a REAL constrained to the inclusive 0..1 range by a CHECK.

const migration004: Migration = {
  version: 4,
  name: 'context_items',
  up(tx: Tx): void {
    const { db } = tx;

    db.exec(`
      CREATE TABLE context_items (
        id            TEXT PRIMARY KEY NOT NULL,
        scope_level   TEXT NOT NULL CHECK (scope_level IN (
                        'global', 'project', 'task', 'workflow', 'source')),
        scope_ref_id  TEXT,
        content       TEXT NOT NULL,
        veracity      TEXT NOT NULL CHECK (veracity IN (
                        'observed_fact', 'inferred', 'unverified_assumption')),
        confidence    REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_context_items_scope
        ON context_items (scope_level, scope_ref_id);
    `);

    // Provenance sources for a context item — one row per source so an item can
    // link to several. derived_from is a JSON array of item ids (nullable).
    db.exec(`
      CREATE TABLE context_provenance (
        id            TEXT PRIMARY KEY NOT NULL,
        item_id       TEXT NOT NULL,
        source_id     TEXT,
        derived_from  TEXT,
        method        TEXT NOT NULL CHECK (method IN (
                        'ingested', 'agent_output', 'user_stated', 'inferred')),
        created_at    TEXT NOT NULL,
        FOREIGN KEY (item_id) REFERENCES context_items (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_context_provenance_item
        ON context_provenance (item_id, created_at);
    `);
  },
};

// Migration 5 — M6 workflow DAG engine. Adds the versioned workflow store and
// per-run execution history. A DAG_Workflow is identified by a stable
// workflow_id and carries a monotonically increasing version; every prior
// version is retained as its own row so any version can be retrieved
// (Requirement 15.3). The graph (triggers, I/O schemas, required context,
// steps/dependencies, branches, loops, policies, approvals, validation
// criteria, error recovery, memory updates) is stored as a single JSON
// definition blob owned by the WorkflowService; the relational columns are the
// identity/version keys the engine queries on.
//
// workflow_runs + workflow_step_history record execution history
// (Requirement 15.5): one run row per execution with its terminal status, and
// one history row per executed step (or loop iteration) with start/end times,
// outcome, attempts consumed, and any error-recovery action taken.

const migration005: Migration = {
  version: 5,
  name: 'workflow_dag_engine',
  up(tx: Tx): void {
    const { db } = tx;

    // workflows — one row per (workflow_id, version). The pair is unique and
    // version is monotonic within a workflow_id. `definition` holds the full
    // DagWorkflow JSON; the WorkflowService owns its (de)serialization.
    db.exec(`
      CREATE TABLE workflows (
        id            TEXT PRIMARY KEY NOT NULL,
        workflow_id   TEXT NOT NULL,
        version       INTEGER NOT NULL,
        name          TEXT NOT NULL,
        definition    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        UNIQUE (workflow_id, version)
      );
      CREATE INDEX idx_workflows_workflow_id
        ON workflows (workflow_id, version);
    `);

    // workflow_runs — one row per execution of a specific workflow version.
    db.exec(`
      CREATE TABLE workflow_runs (
        id            TEXT PRIMARY KEY NOT NULL,
        workflow_id   TEXT NOT NULL,
        version       INTEGER NOT NULL,
        status        TEXT NOT NULL
                        CHECK (status IN ('completed', 'failed', 'aborted')),
        started_at    TEXT NOT NULL,
        ended_at      TEXT NOT NULL
      );
      CREATE INDEX idx_workflow_runs_workflow
        ON workflow_runs (workflow_id, started_at);
    `);

    // workflow_step_history — append-only per-step execution history. One row
    // per executed step or loop iteration (Requirement 15.5/15.6/15.7).
    db.exec(`
      CREATE TABLE workflow_step_history (
        id              TEXT PRIMARY KEY NOT NULL,
        run_id          TEXT NOT NULL,
        step_id         TEXT NOT NULL,
        iteration       INTEGER NOT NULL DEFAULT 1,
        ordinal         INTEGER NOT NULL,
        started_at      TEXT NOT NULL,
        ended_at        TEXT NOT NULL,
        outcome         TEXT NOT NULL
                          CHECK (outcome IN ('succeeded', 'failed', 'skipped')),
        attempts        INTEGER NOT NULL DEFAULT 1,
        recovery_action TEXT,
        detail          TEXT,
        FOREIGN KEY (run_id) REFERENCES workflow_runs (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_workflow_step_history_run
        ON workflow_step_history (run_id, ordinal);
    `);
  },
};

// Migration 6 — M7 skills engine: versioned, agent-independent procedural
// knowledge (Requirement 16). Two tables model the "retain prior versions for
// rollback" requirement (16.6): `skills` is the identity/head row (name, scope,
// the current version number) and `skill_versions` is the append-only history
// of immutable version bodies, one row per (skill_id, version). The large
// structured fields of a version body (required_context, I/O contracts, steps,
// tool_requirements, verification_criteria, examples) are JSON-encoded TEXT;
// the SkillsService owns the serialization, exactly as the orchestrator and
// workflow repositories own their JSON columns. current_version points at the
// head row in skill_versions; a rollback simply repoints it at an older
// version.

const migration006: Migration = {
  version: 6,
  name: 'skills_and_versions',
  up(tx: Tx): void {
    const { db } = tx;

    // skills — identity + head pointer. scope is one of global/project/workflow;
    // scope_ref carries the project or workflow id for the narrowed scopes and
    // is '' for global (NOT NULL keeps the UNIQUE identity constraint simple,
    // mirroring the preferences table's global workspace_id = '' convention). A
    // skill is uniquely identified by (name, scope, scope_ref) so the same name
    // can exist once per scope target.
    db.exec(`
      CREATE TABLE skills (
        id              TEXT PRIMARY KEY NOT NULL,
        name            TEXT NOT NULL,
        scope           TEXT NOT NULL CHECK (scope IN ('global', 'project', 'workflow')),
        scope_ref       TEXT NOT NULL DEFAULT '',
        current_version INTEGER NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE (name, scope, scope_ref)
      );
      CREATE INDEX idx_skills_scope ON skills (scope, scope_ref);
    `);

    // skill_versions — append-only immutable version bodies. One row per
    // (skill_id, version); the head is the row whose version equals
    // skills.current_version. Columns map 1:1 to SkillVersionBody; the JSON
    // columns are serialized by the service. No UPDATE/DELETE path exists for a
    // version row — a new body is always a new version, which is what makes a
    // rollback (repointing current_version) safe.
    db.exec(`
      CREATE TABLE skill_versions (
        skill_id              TEXT NOT NULL,
        version               INTEGER NOT NULL,
        purpose               TEXT NOT NULL,
        applicability         TEXT NOT NULL,
        required_context      TEXT NOT NULL,
        input_contract        TEXT NOT NULL,
        output_contract       TEXT NOT NULL,
        steps                 TEXT NOT NULL,
        tool_requirements     TEXT NOT NULL,
        failure_handling      TEXT NOT NULL,
        verification_criteria TEXT NOT NULL,
        examples              TEXT NOT NULL,
        provenance_method     TEXT NOT NULL
                                CHECK (provenance_method IN ('user_authored', 'agent_output', 'inferred')),
        provenance_source     TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        PRIMARY KEY (skill_id, version),
        FOREIGN KEY (skill_id) REFERENCES skills (id) ON DELETE CASCADE
      );
    `);
  },
};

// Migration 7 — M5 connector framework + ingestion worker (Requirement 14).
// Adds the three tables the connector lifecycle and Ingestion Worker write:
// connectors (the durable lifecycle state — auth, health, sync cursor, retry
// accounting), ingested_items (per-item source/timestamp/permissions/provenance
// metadata; the raw content is held on the data channel and persisted as
// untrusted data, never as trusted text here), and automation_proposals (inert
// candidate auto-workflows / scheduled jobs surfaced for user review).
//
// JSON-encoded columns (permissions, provenance, source_item_ids) are stored as
// TEXT; the repository owns the serialization. content_hash drives change
// detection and dedup. A connector stays in the table after revocation with
// auth_state='revoked' so already-ingested items are retained (Req 14.5).

const migration007: Migration = {
  version: 7,
  name: 'connectors_ingested_items_proposals',
  up(tx: Tx): void {
    const { db } = tx;

    // connectors — durable connector lifecycle state. health starts 'unknown'
    // and flips to 'unhealthy' once a sync exhausts max_retries (Req 14.4).
    db.exec(`
      CREATE TABLE connectors (
        id                   TEXT PRIMARY KEY NOT NULL,
        kind                 TEXT NOT NULL CHECK (kind IN (
                               'email', 'messaging', 'calendar',
                               'files', 'local_mac_context')),
        name                 TEXT NOT NULL,
        auth_state           TEXT NOT NULL CHECK (auth_state IN (
                               'unauthorized', 'authorized', 'revoked')),
        health               TEXT NOT NULL CHECK (health IN (
                               'unknown', 'healthy', 'unhealthy')),
        sync_cursor          TEXT,
        max_retries          INTEGER NOT NULL DEFAULT 3,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_synced_at       TEXT,
        last_error           TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX idx_connectors_kind ON connectors (kind);
    `);

    // ingested_items — per-item metadata only. data_id links to the untrusted
    // data-channel wrapper for the raw content. (connector_id, content_hash)
    // is unique so re-ingesting an unchanged item is a no-op (change detection
    // / dedup).
    db.exec(`
      CREATE TABLE ingested_items (
        id               TEXT PRIMARY KEY NOT NULL,
        connector_id     TEXT NOT NULL,
        source           TEXT NOT NULL CHECK (source IN (
                           'email', 'web', 'file',
                           'tool_output', 'agent_instruction')),
        data_id          TEXT NOT NULL,
        external_id      TEXT,
        source_timestamp TEXT NOT NULL,
        content_hash     TEXT NOT NULL,
        permissions      TEXT NOT NULL DEFAULT '[]',
        provenance       TEXT NOT NULL,
        ingested_at      TEXT NOT NULL,
        FOREIGN KEY (connector_id) REFERENCES connectors (id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_ingested_items_hash
        ON ingested_items (connector_id, content_hash);
      CREATE INDEX idx_ingested_items_connector
        ON ingested_items (connector_id, ingested_at);
    `);

    // automation_proposals — inert candidates for user review (Req 14.6).
    db.exec(`
      CREATE TABLE automation_proposals (
        id              TEXT PRIMARY KEY NOT NULL,
        connector_id    TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN (
                          'auto_workflow', 'scheduled_job')),
        title           TEXT NOT NULL,
        rationale       TEXT NOT NULL,
        source_item_ids TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL CHECK (status IN (
                          'proposed', 'accepted', 'dismissed')),
        created_at      TEXT NOT NULL,
        FOREIGN KEY (connector_id) REFERENCES connectors (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_automation_proposals_connector
        ON automation_proposals (connector_id, created_at);
    `);
  },
};

// Migration 8 — Cross-cutting external-flow transparency & data control
// (Requirement 21). Adds the durable consent registry that gates external data
// flows: Conductor is local-first and transmits data externally only to a
// provider the user has explicitly consented to (Requirement 21.4/21.5). A
// consent stays in the table after revocation with revoked_at set, mirroring
// the permission_grants soft-revocation convention, so the audit trail and the
// "block subsequent flows" check both survive. The user-configurable retention
// / indexing / sync settings (Requirement 21.2) are plain preferences and reuse
// the existing preferences table under the data.* namespace — no new table.

const migration008: Migration = {
  version: 8,
  name: 'external_flow_consents',
  up(tx: Tx): void {
    const { db } = tx;

    db.exec(`
      CREATE TABLE external_flow_consents (
        id          TEXT PRIMARY KEY NOT NULL,
        provider    TEXT NOT NULL,
        granted_at  TEXT NOT NULL,
        revoked_at  TEXT
      );
      CREATE INDEX idx_external_flow_consents_provider
        ON external_flow_consents (provider);
    `);
  },
};

// Migration 9 — M8 self-learning engine (Requirement 18). Two tables model the
// improvement cycle. `task_outcomes` is the append-only record of per-task
// observations the engine evaluates against (18.1): outcome, duration, failure
// count, retry count, verification results, tool usage, and user feedback. The
// comparability_key groups "the same kind of task" so a candidate is evaluated
// only against comparable prior examples (18.2); improvement_id attributes a
// post-adoption outcome to the adopted improvement that was active, which is
// what regression tracking reads (18.5).
//
// `improvement_proposals` is the lifecycle of a demonstrated improvement
// (18.3–18.5): proposed → approved|rejected, and approved → rolled_back. kind
// is constrained to the four allowed learned-artifact kinds — skill, routing
// rule, memory, workflow version — never core code (Property 10). The baseline
// it was measured against and the projected post-adoption metrics are stored as
// JSON TEXT; the service owns their serialization, exactly as the skills and
// workflow repositories own their JSON columns.

const migration009: Migration = {
  version: 9,
  name: 'self_learning_outcomes_and_proposals',
  up(tx: Tx): void {
    const { db } = tx;

    // task_outcomes — append-only per-task observations (Req 18.1). No
    // UPDATE/DELETE code path exists; a new outcome is always a new row, which
    // is what lets the engine evaluate a candidate against an immutable history
    // and attribute post-adoption outcomes for regression tracking (Req 18.5).
    db.exec(`
      CREATE TABLE task_outcomes (
        id                   TEXT PRIMARY KEY NOT NULL,
        task_id              TEXT NOT NULL,
        comparability_key    TEXT NOT NULL,
        result               TEXT NOT NULL CHECK (result IN ('success', 'failure')),
        duration_ms          INTEGER NOT NULL CHECK (duration_ms >= 0),
        failure_count        INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        retry_count          INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        verification_results TEXT NOT NULL DEFAULT '[]',
        tool_usage           TEXT NOT NULL DEFAULT '[]',
        user_feedback        TEXT,
        improvement_id       TEXT,
        recorded_at          TEXT NOT NULL
      );
      CREATE INDEX idx_task_outcomes_key
        ON task_outcomes (comparability_key, recorded_at);
      CREATE INDEX idx_task_outcomes_improvement
        ON task_outcomes (improvement_id, recorded_at);
    `);

    // improvement_proposals — the lifecycle of a demonstrated improvement
    // (Req 18.3–18.5). status transitions proposed -> approved|rejected, and
    // approved -> rolled_back. kind is constrained to the four learned-artifact
    // kinds; core executable code is never a kind (Property 10). baseline and
    // projected hold the PerformanceBaseline JSON the proposal was measured
    // with.
    db.exec(`
      CREATE TABLE improvement_proposals (
        id                TEXT PRIMARY KEY NOT NULL,
        comparability_key TEXT NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN (
                            'skill', 'routing_rule', 'memory', 'workflow_version')),
        summary           TEXT NOT NULL,
        payload           TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN (
                            'proposed', 'approved', 'rejected', 'rolled_back')),
        baseline          TEXT NOT NULL,
        projected         TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        resolved_at       TEXT,
        rolled_back_at    TEXT
      );
      CREATE INDEX idx_improvement_proposals_key
        ON improvement_proposals (comparability_key, created_at);
      CREATE INDEX idx_improvement_proposals_status
        ON improvement_proposals (status);
    `);
  },
};

// Migration 10 — M4 persistent Memory Engine (Requirement 13). Three objects
// model durable long-term memory metadata. `memories` starts as a legacy row:
// every memory belongs to exactly one of the four layers (Req 13.1) and carries
// its origin provenance (source_id + method), veracity, confidence clamped to
// [0, 1], scope, creation timestamp, an optional expiry, and an optional
// superseded_by pointer (Req 13.5/13.6). Migration 19 transfers content to
// Mem0; fresh databases no longer create the historical FTS index here.
// `memory_provenance_events` is an append-only history of the lifecycle events
// that change a memory's standing: supersession (correction/dedup) referencing
// both memory ids (Req 13.5), and veracity promotions recording the triggering
// user-correction / verification event with its source id and timestamp
// (Req 13.8). The engine never promotes inferred/unverified_assumption to
// observed_fact without such an event (Req 13.7 / Property 9).

const migration010: Migration = {
  version: 10,
  name: 'memory_engine',
  up(tx: Tx): void {
    const { db } = tx;

    // memories — the canonical durable row. layer is one of the four
    // Memory_Layers (Req 13.1); veracity/confidence mirror context_items;
    // scope_level/scope_ref_id mirror the ContextScope shape. expires_at is
    // nullable (no expiry); superseded_by points at the memory that corrected
    // or deduplicated this one and is NULL for a live memory (Req 13.5/13.6).
    db.exec(`
      CREATE TABLE memories (
        id            TEXT PRIMARY KEY NOT NULL,
        layer         TEXT NOT NULL CHECK (layer IN (
                        'personal', 'project', 'task', 'procedural')),
        content       TEXT NOT NULL,
        veracity      TEXT NOT NULL CHECK (veracity IN (
                        'observed_fact', 'inferred', 'unverified_assumption')),
        confidence    REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
        source_id     TEXT,
        derived_from  TEXT,
        method        TEXT NOT NULL CHECK (method IN (
                        'ingested', 'agent_output', 'user_stated', 'inferred')),
        scope_level   TEXT NOT NULL CHECK (scope_level IN (
                        'global', 'project', 'task', 'workflow', 'source')),
        scope_ref_id  TEXT,
        expires_at    TEXT,
        superseded_by TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_memories_layer ON memories (layer);
      CREATE INDEX idx_memories_scope ON memories (scope_level, scope_ref_id);
      CREATE INDEX idx_memories_source ON memories (source_id);
      CREATE INDEX idx_memories_created ON memories (created_at);
    `);

    // Fresh databases no longer create the historical FTS index. There is no
    // migration checksum mechanism; v19 drops it on existing installations.

    // memory_provenance_events — append-only lifecycle history. No
    // UPDATE/DELETE code path exists. A supersession records 'supersedes' on
    // the superseding memory and 'superseded_by' on the superseded one, each
    // naming the related memory id (Req 13.5). A promotion records
    // 'user_correction' or 'verification' with the triggering source id and
    // timestamp (Req 13.8).
    db.exec(`
      CREATE TABLE memory_provenance_events (
        id                TEXT PRIMARY KEY NOT NULL,
        memory_id         TEXT NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN (
                            'created', 'superseded_by', 'supersedes',
                            'user_correction', 'verification')),
        related_memory_id TEXT,
        source_id         TEXT,
        created_at        TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_memory_provenance_events_memory
        ON memory_provenance_events (memory_id, created_at);
    `);
  },
};

// Migration 11 — M7 MCP & integration registry (Requirement 17). Two tables.
// `mcp_servers` is the durable registry of external integrations: identity,
// endpoint, trust status, registration/enablement state, health, and the
// approval attribution that gates enablement. A server starts untrusted +
// disabled and can only be enabled after an authorized approver approves it
// (Req 17.9); while untrusted it stays disabled and its invocations are
// rejected (Req 17.10). capabilities is a JSON-encoded array of the capability
// descriptors the server advertises; the registry owns its serialization,
// exactly as the skills and workflow repositories own their JSON columns.
//
// `mcp_exposed_capabilities` is the allowlist of Conductor's own capabilities
// that have been explicitly approved for external exposure through Conductor's
// MCP server (Req 17.8). Only capabilities present here are exposed; an
// unapproved capability is never surfaced to external agents. The registry
// records a lifecycle audit event for registration, enabling, disabling,
// invocation, and access denial in the shared audit_events table (Req 17.7),
// so no per-event table is needed here.

const migration011: Migration = {
  version: 11,
  name: 'mcp_servers_and_exposed_capabilities',
  up(tx: Tx): void {
    const { db } = tx;

    db.exec(`
      CREATE TABLE mcp_servers (
        id                   TEXT PRIMARY KEY NOT NULL,
        name                 TEXT NOT NULL,
        endpoint             TEXT NOT NULL,
        trust_status         TEXT NOT NULL
                               CHECK (trust_status IN ('untrusted', 'trusted')),
        registration_state   TEXT NOT NULL DEFAULT 'registered'
                               CHECK (registration_state IN ('registered')),
        enablement           TEXT NOT NULL
                               CHECK (enablement IN ('disabled', 'enabled')),
        health               TEXT NOT NULL
                               CHECK (health IN ('unknown', 'healthy', 'unhealthy')),
        capabilities         TEXT NOT NULL DEFAULT '[]',
        approved_by          TEXT,
        approved_at          TEXT,
        last_health_check_at TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX idx_mcp_servers_trust ON mcp_servers (trust_status);
    `);

    db.exec(`
      CREATE TABLE mcp_exposed_capabilities (
        capability_id TEXT PRIMARY KEY NOT NULL,
        title         TEXT NOT NULL,
        approved_at   TEXT NOT NULL
      );
    `);
  },
};

// Migration 12 — M8 proactive assistant (Requirement 19). Two tables model the
// "suggest first, auto-execute only when explicitly permitted" principle.
// `suggestions` is the lifecycle record of every generated suggestion (19.1):
// the triggering context, the proposed action, and the human-readable
// explanation, plus the status the assistant tracks it through — suggested,
// auto_executed (matched an explicit low-risk rule within granted permissions,
// 19.4), awaiting_authorization (an external side effect held unexecuted until
// authorized or dismissed, 19.7), confirmed (the user confirmed a suggest-only
// action, 19.5), or dismissed. trigger/action are JSON-encoded TEXT owned by
// the service, exactly as the orchestrator and workflow repositories own their
// JSON columns.
//
// `auto_execute_rules` is the explicit, inspectable opt-in that authorizes an
// action kind for auto-execution (19.4). Its presence is a necessary — never
// sufficient — condition: the assistant also re-checks the subject's granted
// permissions and refuses to auto-execute any action with an external side
// effect. Without a matching enabled rule an action is always suggest-only
// (19.5). A rule binds an action_kind to a subject (agent/workflow) whose
// permissions the auto-execution is checked against.

const migration012: Migration = {
  version: 12,
  name: 'proactive_suggestions_and_auto_execute_rules',
  up(tx: Tx): void {
    const { db } = tx;

    // suggestions — the lifecycle record of every generated suggestion
    // (Req 19.1). trigger_kind / source_id are promoted out of the trigger
    // JSON so the authorized-sources limit (19.6) and per-trigger queries are
    // cheap; the full trigger and action are stored as JSON TEXT. status
    // transitions suggested -> auto_executed | awaiting_authorization |
    // confirmed | dismissed, and awaiting_authorization -> confirmed |
    // dismissed.
    db.exec(`
      CREATE TABLE suggestions (
        id            TEXT PRIMARY KEY NOT NULL,
        trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN (
                        'deadline_approaching', 'email_awaiting_reply',
                        'task_interrupted', 'workflow_due',
                        'document_changed', 'repeated_step_failure')),
        source_id     TEXT NOT NULL,
        trigger       TEXT NOT NULL,
        action        TEXT NOT NULL,
        explanation   TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN (
                        'suggested', 'auto_executed', 'awaiting_authorization',
                        'confirmed', 'dismissed')),
        created_at    TEXT NOT NULL,
        resolved_at   TEXT
      );
      CREATE INDEX idx_suggestions_status ON suggestions (status, created_at);
      CREATE INDEX idx_suggestions_source ON suggestions (source_id);
    `);

    // auto_execute_rules — the explicit low-risk auto-execute opt-in (Req 19.4).
    // (action_kind, subject_type, subject_id) is unique so a kind is authorized
    // at most once per subject. enabled lets a rule be toggled off without
    // losing it; a disabled rule never auto-executes.
    db.exec(`
      CREATE TABLE auto_execute_rules (
        id            TEXT PRIMARY KEY NOT NULL,
        action_kind   TEXT NOT NULL,
        subject_type  TEXT NOT NULL CHECK (subject_type IN ('agent', 'workflow')),
        subject_id    TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at    TEXT NOT NULL,
        UNIQUE (action_kind, subject_type, subject_id)
      );
      CREATE INDEX idx_auto_execute_rules_kind ON auto_execute_rules (action_kind);
    `);
  },
};

// Execution metadata is durable so permissions and adapter inputs survive restart.
const migration013: Migration = {
  version: 13,
  name: 'durable_step_execution_contract',
  up(tx: Tx): void {
    tx.db.exec(`
      ALTER TABLE task_steps ADD COLUMN required_capability TEXT;
      ALTER TABLE task_steps ADD COLUMN required_permissions TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE task_steps ADD COLUMN execution_input TEXT;
    `);
  },
};

const migration014: Migration = {
  version: 14,
  name: 'workflow_task_history',
  up(tx: Tx): void {
    tx.db.exec(`CREATE TABLE workflow_tasks (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL
    );`);
  },
};

// Migration 15 — durable connector ingestion. Connectors gain a per-instance
// JSON `config` (e.g. the folder a files connector indexes and the project it
// serves). Ingested items gain `memory_id`, linking the metadata row to the
// FTS-indexed memory that holds the (untrusted, redacted) content, so ingested
// data survives restarts and is searchable. The external-id index lets a
// changed source item supersede its previous memory instead of duplicating it.
const migration015: Migration = {
  version: 15,
  name: 'connector_config_and_ingested_memory',
  up(tx: Tx): void {
    const { db } = tx;
    db.exec(`
      ALTER TABLE connectors ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE ingested_items ADD COLUMN memory_id TEXT;
      CREATE INDEX idx_ingested_items_external
        ON ingested_items (connector_id, external_id, ingested_at);
    `);
  },
};

// Migration 16 — conversation threads, stored secret metadata and remote hosts.
//  * tasks.thread_id / parent_task_id: a follow-up message is a new task linked
//    to the previous one; thread_id is the first task's id. Agents resume the
//    provider session (Codex) or receive the prior turns as reference.
//  * secrets: metadata for values held in the macOS Keychain (service
//    "Conductor"). The value itself is never stored in SQLite.
//  * remote_hosts: SSH targets that run an agent CLI remotely.
const migration016: Migration = {
  version: 16,
  name: 'threads_secrets_remote_hosts',
  up(tx: Tx): void {
    const { db } = tx;
    db.exec(`
      ALTER TABLE tasks ADD COLUMN thread_id TEXT;
      ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
      CREATE INDEX idx_tasks_thread ON tasks (thread_id, created_at);
      CREATE TABLE secrets (
        id          TEXT PRIMARY KEY NOT NULL,
        label       TEXT NOT NULL,
        owner       TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE remote_hosts (
        id                 TEXT PRIMARY KEY NOT NULL,
        name               TEXT NOT NULL,
        host               TEXT NOT NULL,
        remote_dir         TEXT NOT NULL,
        install_if_missing INTEGER NOT NULL DEFAULT 0 CHECK (install_if_missing IN (0, 1)),
        enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at         TEXT NOT NULL
      );
    `);
  },
};

// Migration 17 — multi-agent plan mode and usage.
//  * task_plans: a plan-mode task's planner agent, its validated plan (JSON)
//    and where the plan documents were written. One row per task.
//  * agent_usage: token counts (and cost when reported) per agent session,
//    updated with the session's running totals. step_id is NULL for the
//    planner session.
//  * agent_sessions.step_id: which step a session ran, now that several steps
//    of one task can run at the same time.
const migration017: Migration = {
  version: 17,
  name: 'plan_mode_usage',
  up(tx: Tx): void {
    const { db } = tx;
    db.exec(`
      CREATE TABLE task_plans (
        task_id            TEXT PRIMARY KEY NOT NULL,
        planner_adapter_id TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('requested', 'planning', 'ready', 'failed')),
        plan               TEXT,
        docs_dir           TEXT,
        error              TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
      );
      CREATE TABLE agent_usage (
        session_id            TEXT PRIMARY KEY NOT NULL,
        task_id               TEXT NOT NULL,
        step_id               TEXT,
        workspace_id          TEXT NOT NULL,
        adapter_id            TEXT NOT NULL,
        model                 TEXT,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
        total_tokens          INTEGER NOT NULL DEFAULT 0,
        cost_usd              REAL,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_agent_usage_created ON agent_usage (created_at);
      CREATE INDEX idx_agent_usage_task ON agent_usage (task_id);
      ALTER TABLE agent_sessions ADD COLUMN step_id TEXT;
    `);
  },
};

// Migration 18 — per-message model and effort choices (composer pickers).
// JSON RunOptions: { main?: {model, effort}, mainAgentId?: string,
// agents?: { [agentId]: {...} } }. mainAgentId prevents a fallback provider
// from receiving the originally selected CLI's model slug.
const migration018: Migration = {
  version: 18,
  name: 'task_run_options',
  up(tx: Tx): void {
    tx.db.exec(`
      ALTER TABLE tasks ADD COLUMN run_options TEXT;
      ALTER TABLE task_plans ADD COLUMN planner_run TEXT;
    `);
  },
};

// Keep legacy content until the asynchronous transfer has been acknowledged.
// The delete trigger covers every relational deletion path, including cascades.
const migration019: Migration = {
  version: 19,
  name: 'mem0_memory_storage',
  up({ db }: Tx): void {
    db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memories_fts;
      UPDATE task_steps SET execution_input=json_remove(execution_input, '$.contextData')
        WHERE execution_input IS NOT NULL AND json_valid(execution_input);
      ALTER TABLE memories ADD COLUMN mem0_id TEXT;
      ALTER TABLE memories ADD COLUMN mem0_dirty INTEGER NOT NULL DEFAULT 1;
      CREATE UNIQUE INDEX idx_memories_mem0 ON memories(mem0_id);
      CREATE TABLE mem0_namespace (id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT NOT NULL);
      INSERT INTO mem0_namespace VALUES (1, 'conductor-' || lower(hex(randomblob(16))));
      CREATE TABLE mem0_deletions (
        memory_id TEXT PRIMARY KEY NOT NULL,
        mem0_id TEXT
      );
      CREATE TRIGGER memories_mem0_delete AFTER DELETE ON memories BEGIN
        INSERT OR REPLACE INTO mem0_deletions(memory_id, mem0_id) VALUES(old.id, old.mem0_id);
      END;
      CREATE TRIGGER memories_mem0_metadata AFTER UPDATE OF layer,veracity,confidence,source_id,derived_from,method,scope_level,scope_ref_id,expires_at,superseded_by ON memories BEGIN
        UPDATE memories SET mem0_dirty=1 WHERE id=new.id;
      END;
    `);
  },
};

// Casual Chat has no workspace, task, context, memory, or provider-session link.
const migration020: Migration = {
  version: 20,
  name: 'standalone_chat',
  up({ db }: Tx): void {
    db.exec(`
      CREATE TABLE chat_threads (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_chat_threads_updated ON chat_threads(updated_at DESC);
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('complete','streaming','failed','cancelled')),
        created_at TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id);
    `);
  },
};

// Migration 21 — learned-skill triggers and their execution history. Bindings
// attach a versioned skill to a normalized external trigger (initially vendor
// identifiers) and retain the extraction template discovered while authoring
// the skill. Usage rows point at the exact immutable skill version that ran so
// later head changes cannot rewrite history.
const migration021: Migration = {
  version: 21,
  name: 'skill_bindings_and_usages',
  up({ db }: Tx): void {
    db.exec(`
      CREATE TABLE skill_bindings (
        id                  TEXT PRIMARY KEY NOT NULL,
        skill_id            TEXT NOT NULL,
        trigger_type        TEXT NOT NULL CHECK (trigger_type IN ('vendor')),
        trigger_key         TEXT NOT NULL,
        trigger_aliases     TEXT NOT NULL DEFAULT '[]',
        extraction_template TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        last_used_at        TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        FOREIGN KEY (skill_id) REFERENCES skills (id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_skill_bindings_trigger
        ON skill_bindings (trigger_type, trigger_key);
      CREATE INDEX idx_skill_bindings_skill
        ON skill_bindings (skill_id);

      CREATE TABLE skill_usages (
        id            TEXT PRIMARY KEY NOT NULL,
        binding_id    TEXT,
        task_id       TEXT,
        skill_id      TEXT NOT NULL,
        skill_version INTEGER NOT NULL,
        trigger_key   TEXT NOT NULL,
        outcome       TEXT NOT NULL
                        CHECK (outcome IN ('pending', 'completed', 'failed', 'skipped')),
        started_at    TEXT NOT NULL,
        completed_at  TEXT,
        FOREIGN KEY (binding_id) REFERENCES skill_bindings (id) ON DELETE SET NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE SET NULL,
        FOREIGN KEY (skill_id, skill_version)
          REFERENCES skill_versions (skill_id, version) ON DELETE CASCADE
      );
      CREATE INDEX idx_skill_usages_binding
        ON skill_usages (binding_id, started_at DESC);
      CREATE INDEX idx_skill_usages_task
        ON skill_usages (task_id);
      CREATE INDEX idx_skill_usages_skill_version
        ON skill_usages (skill_id, skill_version, started_at DESC);
    `);
  },
};

// Migration 22 — attachments. A managed blob row plus ordered links from a
// task message (tasks are one message each) and from a casual-chat message.
//   * attachments: renderer-safe metadata and managed-storage ids. `blob_id`
//     points at the DiskManagedStorage blob, `thumbnail_blob_id` at a resized
//     image thumbnail; extracted_text caches bounded, redacted document text.
//     sha256 is indexed (not unique) so the service can reuse one blob for
//     identical content while keeping the user's per-ingest display name.
//   * task_attachments / chat_message_attachments: ordinal preserves picker
//     order. Deleting the task/message cascades the links; the service then
//     removes unreferenced attachment rows and their blobs.
//   * materialized_path records the per-owner copy handed to an agent. It is
//     main-process-only and must never be returned to the renderer.
const migration022: Migration = {
  version: 22,
  name: 'attachments',
  up({ db }: Tx): void {
    db.exec(`
      CREATE TABLE attachments (
        id                    TEXT PRIMARY KEY NOT NULL,
        name                  TEXT NOT NULL,
        kind                  TEXT NOT NULL CHECK (kind IN (
                                'image', 'markdown', 'text', 'pdf',
                                'docx', 'doc', 'unsupported')),
        mime_type             TEXT NOT NULL,
        size_bytes            INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256                TEXT NOT NULL,
        blob_id               TEXT NOT NULL,
        thumbnail_blob_id     TEXT,
        extracted_text        TEXT,
        extracted_truncated   INTEGER NOT NULL DEFAULT 0
                                CHECK (extracted_truncated IN (0, 1)),
        page_count            INTEGER CHECK (page_count IS NULL OR page_count >= 0),
        width                 INTEGER CHECK (width IS NULL OR width > 0),
        height                INTEGER CHECK (height IS NULL OR height > 0),
        created_at            TEXT NOT NULL
      );
      CREATE INDEX idx_attachments_sha256 ON attachments (sha256);
      CREATE INDEX idx_attachments_created_at ON attachments (created_at);

      CREATE TABLE task_attachments (
        task_id           TEXT NOT NULL,
        attachment_id     TEXT NOT NULL,
        ordinal           INTEGER NOT NULL CHECK (ordinal >= 0),
        materialized_path TEXT,
        created_at        TEXT NOT NULL,
        PRIMARY KEY (task_id, attachment_id),
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
        FOREIGN KEY (attachment_id) REFERENCES attachments (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_task_attachments_order
        ON task_attachments (task_id, ordinal);
      CREATE INDEX idx_task_attachments_attachment
        ON task_attachments (attachment_id);

      CREATE TABLE chat_message_attachments (
        message_id        TEXT NOT NULL,
        attachment_id     TEXT NOT NULL,
        ordinal           INTEGER NOT NULL CHECK (ordinal >= 0),
        materialized_path TEXT,
        created_at        TEXT NOT NULL,
        PRIMARY KEY (message_id, attachment_id),
        FOREIGN KEY (message_id) REFERENCES chat_messages (id) ON DELETE CASCADE,
        FOREIGN KEY (attachment_id) REFERENCES attachments (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_chat_message_attachments_order
        ON chat_message_attachments (message_id, ordinal);
      CREATE INDEX idx_chat_message_attachments_attachment
        ON chat_message_attachments (attachment_id);
    `);
  },
};

// Migration 23 — per-CLI quota windows. The latest snapshot a CLI reported for
// its session and weekly limits, keyed by adapter and window kind so a new
// sample overwrites the previous one. Percentages are nullable: a missing
// value means "not reported" and must stay distinguishable from a reported 0.
// remaining_percent / used_percent are checked into the inclusive 0..100 range;
// resets_at is the provider's reset time and reported_at is when the CLI
// supplied the sample. Only quota values and their source are stored; no
// prompts or secrets.
const migration023: Migration = {
  version: 23,
  name: 'agent_usage_limits',
  up({ db }: Tx): void {
    db.exec(`
      CREATE TABLE agent_usage_limits (
        adapter_id        TEXT NOT NULL,
        window_kind       TEXT NOT NULL
                            CHECK (window_kind IN ('session', 'weekly')),
        remaining_percent REAL
                            CHECK (remaining_percent IS NULL
                              OR (remaining_percent >= 0 AND remaining_percent <= 100)),
        used_percent      REAL
                            CHECK (used_percent IS NULL
                              OR (used_percent >= 0 AND used_percent <= 100)),
        resets_at         TEXT,
        reported_at       TEXT NOT NULL,
        source            TEXT,
        window_minutes    INTEGER
                            CHECK (window_minutes IS NULL OR window_minutes >= 0),
        updated_at        TEXT NOT NULL,
        PRIMARY KEY (adapter_id, window_kind)
      );
      CREATE INDEX idx_agent_usage_limits_reported
        ON agent_usage_limits (reported_at);
    `);
  },
};

// Migration 24 — durable activity rows for standalone Chat replies. The JSON
// contains only adapter-emitted, redacted activity metadata; conversation text
// remains in chat_messages.content.
const migration024: Migration = {
  version: 24,
  name: 'chat_message_activity',
  up({ db }: Tx): void {
    db.exec("ALTER TABLE chat_messages ADD COLUMN activity_json TEXT NOT NULL DEFAULT '[]';");
  },
};

// Migration 25 — an optional label for a quota window. A provider can split a
// single kind into separate quotas (Antigravity's model groups); the label
// identifies which group the stored "most constrained" window came from.
const migration025: Migration = {
  version: 25,
  name: 'agent_usage_limits_label',
  up({ db }: Tx): void {
    db.exec('ALTER TABLE agent_usage_limits ADD COLUMN label TEXT;');
  },
};

// Migration 26 — allow the daily window kind used by OpenCode's free tier.
// SQLite cannot alter a CHECK constraint in place, so rebuild the table and
// copy every existing snapshot. The label column arrives in migration 25.
const migration026: Migration = {
  version: 26,
  name: 'agent_usage_limits_daily',
  up({ db }: Tx): void {
    db.exec(`
      CREATE TABLE agent_usage_limits_next (
        adapter_id        TEXT NOT NULL,
        window_kind       TEXT NOT NULL
                            CHECK (window_kind IN ('session', 'daily', 'weekly')),
        remaining_percent REAL
                            CHECK (remaining_percent IS NULL
                              OR (remaining_percent >= 0 AND remaining_percent <= 100)),
        used_percent      REAL
                            CHECK (used_percent IS NULL
                              OR (used_percent >= 0 AND used_percent <= 100)),
        resets_at         TEXT,
        reported_at       TEXT NOT NULL,
        source            TEXT,
        window_minutes    INTEGER
                            CHECK (window_minutes IS NULL OR window_minutes >= 0),
        updated_at        TEXT NOT NULL,
        label             TEXT,
        PRIMARY KEY (adapter_id, window_kind)
      );
      INSERT INTO agent_usage_limits_next
        (adapter_id, window_kind, remaining_percent, used_percent, resets_at,
         reported_at, source, window_minutes, updated_at, label)
        SELECT adapter_id, window_kind, remaining_percent, used_percent, resets_at,
               reported_at, source, window_minutes, updated_at, label
        FROM agent_usage_limits;
      DROP TABLE agent_usage_limits;
      ALTER TABLE agent_usage_limits_next RENAME TO agent_usage_limits;
      CREATE INDEX idx_agent_usage_limits_reported
        ON agent_usage_limits (reported_at);
    `);
  },
};

// Migration 27 — user-chosen Work thread titles. The title lives on the
// thread's root task (the task whose id is the thread id); NULL means the
// title is still derived from that task's objective.
const migration027: Migration = {
  version: 27,
  name: 'task_thread_title',
  up({ db }: Tx): void {
    db.exec('ALTER TABLE tasks ADD COLUMN title TEXT;');
  },
};

// Migration 28 — GitHub pull requests filed for Work threads. The latest PR
// for a thread is mirrored onto its root task (pr_number/pr_url/pr_state) so
// lists render without a join; this table keeps the full per-project history.
const migration028: Migration = {
  version: 28,
  name: 'github_pull_requests',
  up({ db }: Tx): void {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN pr_number INTEGER;
      ALTER TABLE tasks ADD COLUMN pr_url TEXT;
      ALTER TABLE tasks ADD COLUMN pr_state TEXT;
      CREATE TABLE github_pull_requests (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        root_task_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        branch TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_github_prs_workspace ON github_pull_requests (workspace_id, updated_at);
      CREATE INDEX idx_github_prs_thread ON github_pull_requests (thread_key);
    `);
  },
};

// Migration 29 — which agent CLI and model produced each chat reply, so a
// switch of CLI or model between (or within) replies can be shown as a
// handoff in the conversation instead of changing silently.
const migration029: Migration = {
  version: 29,
  name: 'chat_message_agent_model',
  up({ db }: Tx): void {
    db.exec(`
      ALTER TABLE chat_messages ADD COLUMN agent_id TEXT;
      ALTER TABLE chat_messages ADD COLUMN model TEXT;
    `);
  },
};

/** All migrations in version order. Must be a gapless 1..N sequence. */
export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
  migration029,
];
