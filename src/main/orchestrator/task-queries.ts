import type { AttachmentService } from '../attachments/attachment-service';
import type { Store } from '../db/types';
import type { Orchestrator } from './orchestrator';
import type { PermissionService } from '../domain/permission-service';
import type { ManagedStorage } from '../storage/managed-storage';
import type { ArtifactPreview, ArtifactSummary, TaskDetails, TaskVerification } from '@shared/task-view';
import type { Task, TaskEvent, TaskStep } from '@shared/domain';
import { redact } from '../ipc/redaction';
import { taskUsage } from '../usage/usage';
import type { TaskPlanView } from '@shared/plan';

/** The model/effort a step's agent ran with, from its stored execution input. */
function stepRun(raw: unknown, adapterId: unknown): { run: NonNullable<TaskStep['run']> } | Record<string, never> {
  if (typeof raw !== 'string' || typeof adapterId !== 'string') return {};
  try {
    const input = JSON.parse(raw) as { runs?: Record<string, NonNullable<TaskStep['run']>>; models?: Record<string, string>; efforts?: Record<string, string>; difficulty?: string };
    const key = adapterId.startsWith('remote:') ? 'codex' : adapterId;
    const run = input.runs?.[key];
    if (run !== undefined) return { run };
    const model = input.models?.[key];
    const effort = input.efforts?.[key];
    return model !== undefined || effort !== undefined ? { run: { ...(model ? { model } : {}), ...(effort ? { effort } : {}), source: 'settings' } } : {};
  } catch { return {}; }
}

export class TaskQueries {
  constructor(private readonly store:Store,private readonly orchestrator:Orchestrator,
    private readonly permissions:PermissionService,private readonly storage:ManagedStorage,
    /** Plan-mode view of a task (null for a single-agent task). */
    private readonly planView?: (taskId: string) => TaskPlanView | null,
    private readonly attachments?: AttachmentService) {}

  list(input: {workspaceId?:string;limit?:number} = {}): Task[] {
    const rows = this.store.db.prepare(`SELECT id FROM tasks ${input.workspaceId ? 'WHERE workspace_id = ?' : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...(input.workspaceId ? [input.workspaceId] : []),input.limit ?? 100) as {id:string}[];
    return rows.map((r)=>this.orchestrator.getTask(r.id)!);
  }

  /** Every task in a conversation thread, oldest first. */
  thread(threadId: string): Task[] {
    const rows = this.store.db.prepare(`SELECT id FROM tasks WHERE thread_id = ? OR id = ?
      ORDER BY created_at ASC, rowid ASC LIMIT 200`).all(threadId, threadId) as {id:string}[];
    return rows.map((r)=>this.orchestrator.getTask(r.id)!).filter((t) => (t.threadId ?? t.id) === threadId);
  }
  details(id: string): TaskDetails {
    const task = this.orchestrator.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const rows = this.store.db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY ordinal').all(id) as Record<string,unknown>[];
    const steps:TaskStep[] = rows.map((r)=>({id:r['id'] as string,taskId:id,ordinal:r['ordinal'] as number,
      description:r['description'] as string,dependsOn:JSON.parse(r['depends_on'] as string) as string[],
      status:r['status'] as TaskStep['status'],
      ...(r['assigned_adapter_id'] ? {assignedAdapterId:r['assigned_adapter_id'] as string}:{}),
      ...(r['started_at'] ? {startedAt:r['started_at'] as string}:{}),
      ...(r['ended_at'] ? {endedAt:r['ended_at'] as string}:{}),
      ...stepRun(r['execution_input'], r['assigned_adapter_id']),
    }));
    // Several agents stream into a plan task at once, so keep more history.
    const eventLimit = steps.length > 1 ? 3000 : 500;
    const eventRows = this.store.db.prepare('SELECT * FROM (SELECT rowid,* FROM task_events WHERE task_id=? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid').all(id, eventLimit) as Record<string,unknown>[];
    const events:TaskEvent[] = eventRows.map((r)=>({id:r['id'] as string,taskId:id,
      ...(r['step_id'] ? {stepId:r['step_id'] as string}:{}),kind:r['kind'] as TaskEvent['kind'],
      payload:redact(JSON.parse(r['payload'] as string)),createdAt:r['created_at'] as string}));
    const artifacts = new Map<string,ArtifactSummary>();
    // Query artifact references separately so old outputs stay visible even after long streams.
    const artifactRows = this.store.db.prepare("SELECT step_id,payload,created_at FROM task_events WHERE task_id=? AND (kind='artifact' OR json_extract(payload,'$.artifactId') IS NOT NULL)").all(id) as {step_id:string|null;payload:string;created_at:string}[];
    for (const row of artifactRows) {
      const payload = JSON.parse(row.payload) as Record<string,unknown>;
      if (typeof payload['artifactId'] !== 'string') continue;
      artifacts.set(payload['artifactId'],{id:payload['artifactId'],createdAt:row.created_at,
        ...(row.step_id ? {stepId:row.step_id}:{}),
        ...(typeof payload['name']==='string' ? {name:payload['name']}:{}),
        ...(typeof payload['contentType']==='string' ? {mimeType:payload['contentType']}:{}),
        ...(typeof payload['byteLength']==='number' ? {sizeBytes:payload['byteLength']}:{}),
      });
    }
    const checkpoint = this.store.db.prepare(`SELECT * FROM checkpoints WHERE task_id=?
      AND (json_type(snapshot,'$.criteria')='array' OR json_extract(snapshot,'$.verificationFinished')=0)
      ORDER BY rowid DESC LIMIT 1`).get(id) as {id:string;verified:number;snapshot:string}|undefined;
    let verification:TaskVerification|null = null;
    if (checkpoint) {
      const snap = JSON.parse(checkpoint.snapshot) as Record<string,unknown>;
      verification = {checkpointId:checkpoint.id,verified:checkpoint.verified===1,finished:snap['verificationFinished']!==false,
        criteria:(snap['criteria'] ?? []) as TaskVerification['criteria'],
        ...(typeof snap['verifiedAt']==='string' ? {verifiedAt:snap['verifiedAt']}:{}),
      };
    }
    this.permissions.expireTimedOut();
    const approvals = (this.store.db.prepare('SELECT id FROM approval_requests WHERE task_id=? ORDER BY rowid').all(id) as {id:string}[])
      .map((r)=>this.permissions.getApproval(r.id)!);
    const plan = this.planView?.(id) ?? null;
    const usage = taskUsage(this.store, id);
    return redact({task,steps,events,artifacts:[...artifacts.values()],attachments:this.attachments?.listTask(id) ?? [],approvals,verification,plan,usage}) as TaskDetails;
  }

  readArtifact(input:{taskId:string;artifactId:string}):ArtifactPreview {
    if (!this.details(input.taskId).artifacts.some((a)=>a.id===input.artifactId)) throw new Error('Artifact does not belong to this task');
    const buffer = this.storage.get(input.artifactId);
    if (buffer.subarray(0,4096).includes(0)) throw new Error('Binary artifact cannot be previewed as text');
    const limit=128*1024;
    return {text:redact(buffer.subarray(0,limit).toString('utf8')) as string,truncated:buffer.length>limit};
  }
}
