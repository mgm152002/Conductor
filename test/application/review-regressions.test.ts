import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { WorkspaceService } from '@main/domain/workspace-service';
import { AuditLog } from '@main/domain/audit-log';
import { PermissionService } from '@main/domain/permission-service';
import { Registry } from '@main/registry/registry';
import { TaskStateMachine } from '@main/orchestrator/state-machine';
import { TaskCanceller } from '@main/orchestrator/cancellation';
import { Orchestrator } from '@main/orchestrator/orchestrator';
import { evidenceEvaluator } from '@main/orchestrator/evidence-evaluator';
import { makeFakeAdapter } from '../fakes/fake-adapter';
import type { AgentAdapter, AdapterStreamEvent } from '@shared/adapter';

let store: SqliteStore;
let permissions: PermissionService;
let registry: Registry;
let machine: TaskStateMachine;
let orchestrator: Orchestrator;
let workspaceId: string;
let storage: DiskManagedStorage;
let blobRoot: string;
beforeEach(async () => {
  store = new SqliteStore(':memory:'); await store.migrate();
  blobRoot = mkdtempSync(join(tmpdir(),'conductor-review-blobs-')); storage = new DiskManagedStorage(blobRoot);
  const audit = new AuditLog(store);
  const workspaces = new WorkspaceService(store);
  workspaceId = workspaces.create({name:'Review', rootPath: process.cwd()}).id;
  permissions = new PermissionService(store,audit); registry = new Registry(); machine = new TaskStateMachine(store,audit);
  const canceller = new TaskCanceller(store,machine,registry,audit);
  orchestrator = new Orchestrator(store,machine,workspaces,canceller,audit,{registry,permissions,storage,maxStepRetries:2,baseStepBackoffMs:0,criterionEvaluator:evidenceEvaluator(store)});
});
afterEach(() => {store.close();rmSync(blobRoot,{recursive:true,force:true});});
function adapter(required = false) {
  return makeFakeAdapter({record:{id:'review-agent', capabilities:[{id:'objective.fulfill',title:'Review', inputSchema:{},outputSchema:{},streaming:true,cancellable:true,resumable:false,requiredPermissions:required ? [{kind:'filesystem_read'}] : []}]}});
}
async function task(agent: AgentAdapter, criterion='response: nonempty') {
  registry.register(agent);
  const created = await orchestrator.createTask({workspaceId,objective:'Review regression',acceptanceCriteria:[criterion]});
  await orchestrator.beginExecution(created.id); return created;
}
function event(data:string):AdapterStreamEvent { return {kind:'stdout',data,sequence:1,at:new Date().toISOString()}; }

it('cancels a handle returned after the user cancelled while start was pending', async () => {
  const agent=adapter();
  const start=agent.start.bind(agent);
  let entered!:()=>void; const started=new Promise<void>((resolve)=>{entered=resolve;});
  let release!:()=>void; const pending=new Promise<void>((resolve)=>{release=resolve;});
  agent.start=async(input)=>{ entered(); await pending; return start(input); };
  const created=await task(agent);
  const running=orchestrator.runSteps(created.id);
  await started; await orchestrator.cancelTask(created.id); release(); await running;
  expect(machine.getTask(created.id)?.state).toBe('CANCELLED');
  expect(agent.calls.cancelled).toHaveLength(1);
  expect(agent.calls.streamed).toBe(0);
  expect(agent.calls.started).toHaveLength(1);
});

it('cancels running permission-dependent work on revocation and never retries it', async () => {
  permissions.grant({subject:{type:'agent',id:'orchestrator'},profile:'read_only'});
  const agent=adapter(true);
  agent.stream=async function* () {
    permissions.revoke({subject:{type:'agent',id:'orchestrator'}});
    yield event('Revoked work');
  };
  const created=await task(agent);
  await orchestrator.runSteps(created.id);
  expect(agent.calls.cancelled).toHaveLength(1);
  expect(agent.calls.started).toHaveLength(1);
  expect(store.db.prepare('SELECT status FROM task_steps WHERE task_id=?').get(created.id)).toMatchObject({status:'cancelled'});
  await orchestrator.verifyTask(created.id);
  expect(machine.getTask(created.id)?.state).toBe('FAILED');
});

it('cancels work if permission is revoked while its adapter start is pending', async () => {
  permissions.grant({subject:{type:'agent',id:'orchestrator'},profile:'read_only'});
  const agent=adapter(true); const start=agent.start.bind(agent);
  agent.start=async(input)=>{ permissions.revoke({subject:{type:'agent',id:'orchestrator'}}); return start(input); };
  const created=await task(agent); await orchestrator.runSteps(created.id);
  expect(agent.calls.cancelled).toHaveLength(1);
  expect(agent.calls.streamed).toBe(0);
  expect(agent.calls.started).toHaveLength(1);
});

it('does not use failed-attempt stdout to satisfy acceptance criteria after a successful retry', async () => {
  const agent=adapter(); let attempt=0;
  const start=agent.start.bind(agent); agent.start=async(input)=>{attempt++;return start(input);};
  agent.stream=async function* () {yield event(attempt===1?'expected acceptance marker':'unrelated successful response');};
  agent.await=async()=>attempt===1 ? {status:'failed'} : {status:'succeeded'};
  const created=await task(agent,'contains: expected acceptance marker');
  await orchestrator.runSteps(created.id); await orchestrator.verifyTask(created.id);
  expect(machine.getTask(created.id)?.state).toBe('FAILED');
  const rows=store.db.prepare("SELECT payload FROM task_events WHERE task_id=? AND kind='stream'").all(created.id) as {payload:string}[];
  const payloads=rows.map((row)=>JSON.parse(row.payload) as {sessionId:string;attempt:number});
  expect(payloads.map((payload)=>payload.attempt)).toEqual([0,1]);
  expect(new Set(payloads.map((payload)=>payload.sessionId)).size).toBe(2);
});

it('requires stdout from the successful final session, and verifies real successful stdout', async () => {
  const agent=adapter(); let attempt=0;
  const start=agent.start.bind(agent); agent.start=async(input)=>{attempt++;return start(input);};
  agent.stream=async function* () {if(attempt===1) yield event('Earlier failed response');};
  agent.await=async()=>attempt===1 ? {status:'failed'} : {status:'succeeded'};
  const created=await task(agent); await orchestrator.runSteps(created.id); await orchestrator.verifyTask(created.id);
  expect(machine.getTask(created.id)?.state).toBe('FAILED');
  registry.deregister(agent.record.id);
  const next=adapter(); next.record.id='second-agent';
  next.stream=async function*(){yield event('A verified successful response');};
  const second=await task(next); await orchestrator.runSteps(second.id); await orchestrator.verifyTask(second.id);
  expect(machine.getTask(second.id)?.state).toBe('COMPLETED');
});


it('redacts serialized credentials before storing stdout, streamed artifacts and result output', async () => {
  const agent=adapter();
  agent.stream=async function* () {
    yield event('{"api_key":"stdout-credential"}');
    yield {...event('{"password":"artifact-credential"}'),kind:'artifact' as const,sequence:2};
  };
  agent.await=async()=>({status:'succeeded',output:'{"api_key":"result-credential"}'});
  const created=await task(agent); await orchestrator.runSteps(created.id);
  const events=store.db.prepare('SELECT payload FROM task_events WHERE task_id=?').all(created.id) as {payload:string}[];
  const allEvents=events.map((row)=>row.payload).join('\n');
  expect(allEvents).not.toContain('stdout-credential');
  expect(allEvents).not.toContain('artifact-credential');
  const ids=events.map((row)=>(JSON.parse(row.payload) as {artifactId?:string}).artifactId).filter((id):id is string=>Boolean(id));
  expect(ids.length).toBeGreaterThanOrEqual(3);
  const artifacts=ids.map((id)=>storage.get(id).toString('utf8')).join('\n');
  expect(artifacts).not.toContain('stdout-credential');
  expect(artifacts).not.toContain('artifact-credential');
  expect(artifacts).not.toContain('result-credential');
  expect(artifacts).toContain('[REDACTED]');
});
