import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Store } from '../db/types';
import type { CriterionEvaluator } from './verifier';
import { responseText } from '../adapters/objective-cli-adapter';
import { isCodexProtocol } from './thread-context';
import { worktreePathFor } from '../domain/worktree';

/** Explicit evidence rules; only the successful final session can verify its step. */
export function evidenceEvaluator(store: Store): CriterionEvaluator {
  return ({task,criterion,index}) => {
    const steps = store.db.prepare('SELECT id,status,assigned_adapter_id FROM task_steps WHERE task_id=? ORDER BY ordinal').all(task.id) as {id:string;status:string;assigned_adapter_id:string|null}[];
    const fail = (detail:string) => ({criterion,index,satisfied:false,detail});
    if (steps.length === 0 || steps.some((s)=>s.status!=='succeeded')) return fail('At least one execution step did not succeed.');
    const outputs: string[] = [];
    for (const step of steps) {
      const checkpoint = store.db.prepare(`SELECT snapshot FROM checkpoints WHERE task_id=? AND step_id=?
        AND json_extract(snapshot,'$.status')='succeeded' ORDER BY rowid DESC LIMIT 1`).get(task.id,step.id) as {snapshot:string}|undefined;
      if (!checkpoint) return fail('No successful-session checkpoint was recorded for a step.');
      const success = JSON.parse(checkpoint.snapshot) as {sessionId?:unknown;attempt?:unknown};
      if (typeof success.sessionId !== 'string' || typeof success.attempt !== 'number') return fail('This task predates session-scoped verification evidence; rerun it to verify.');
      const session = store.db.prepare('SELECT status,adapter_id FROM agent_sessions WHERE task_id=? AND id=?').get(task.id,success.sessionId) as {status:string;adapter_id:string}|undefined;
      if (!session || session.status !== 'exited' || session.adapter_id !== step.assigned_adapter_id) return fail('The successful session is missing or did not exit successfully.');
      const rows = store.db.prepare(`SELECT payload FROM task_events WHERE task_id=? AND step_id=? AND kind='stream'
        AND json_extract(payload,'$.kind')='stdout' AND json_extract(payload,'$.sessionId')=?
        AND json_extract(payload,'$.attempt')=? ORDER BY rowid`).all(task.id,step.id,success.sessionId,success.attempt) as {payload:string}[];
      const raw = rows.map((row)=>(JSON.parse(row.payload) as {data:unknown}).data).filter((data): data is string => typeof data==='string').join('\n');
      const output = isCodexProtocol(step.assigned_adapter_id) ? responseText(raw) : raw;
      if (!output.trim()) return fail('No response evidence was recorded for a successful final session.');
      outputs.push(output);
    }
    const output = outputs.join('\n');
    const rule = criterion.trim();
    if (rule==='response: nonempty') return {criterion,index,satisfied:true,detail:'Each successful final session recorded a response; review its content in the conversation.'};
    if (/^contains:/i.test(rule)) {
      const expected=rule.slice(rule.indexOf(':')+1).trim();
      return {criterion,index,satisfied:expected.length>0 && output.includes(expected),detail:`Checked successful final responses for: ${expected}`};
    }
    if (/^file:/i.test(rule)) {
      const row=store.db.prepare('SELECT root_path FROM workspaces WHERE id=?').get(task.workspaceId) as {root_path:string};
      // The agent worked in the thread's worktree when one exists.
      const candidate = worktreePathFor(row.root_path, task.threadId ?? task.id);
      const root=realpathSync(existsSync(candidate) ? candidate : row.root_path); const path=resolve(root,rule.slice(rule.indexOf(':')+1).trim());
      if (!existsSync(path)) return fail('Expected file does not exist.');
      const ownerRelative=relative(root,realpathSync(path));
      if (ownerRelative==='..' || ownerRelative.startsWith('../') || isAbsolute(ownerRelative)) return fail('File criterion must stay within the workspace, including symlinks.');
      return {criterion,index,satisfied:statSync(path).isFile(),detail:`Checked workspace file: ${ownerRelative}`};
    }
    return fail('No automatic evidence rule for this criterion. Use contains: text, file: relative/path, or response: nonempty.');
  };
}
