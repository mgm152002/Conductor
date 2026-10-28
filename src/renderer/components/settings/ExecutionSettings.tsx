import { useTaskStore, useApprovalStore } from '../../stores';
import { useEffect, useState } from 'react';
import { reportMemoryCleanup } from '../../lib/memory-cleanup';
import type { DataControlSettings, DataDeletionTarget, ExternalFlowConsent, PermissionProfile } from '@shared/domain';
import { Switch } from '../ui/primitives';

const providers = [{id:'codex',label:'Codex CLI'},{id:'claude-code',label:'Claude Code'},{id:'opencode',label:'OpenCode'},{id:'antigravity',label:'Antigravity CLI'},{id:'kiro',label:'Kiro CLI'}];
export function ExecutionSettings():React.JSX.Element {
  const [profile,setProfile]=useState<PermissionProfile>('read_only');
  const [autoApprove,setAutoApprove]=useState(false);
  const [settings,setSettings]=useState<DataControlSettings|null>(null);
  const [consents,setConsents]=useState<ExternalFlowConsent[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [status,setStatus]=useState('');
  const [busy,setBusy]=useState(false);
  const [target,setTarget]=useState<DataDeletionTarget>('tasks');
  const [confirmDelete,setConfirmDelete]=useState(false);
  async function refresh():Promise<void> {
    setError(null);
    try { const [p,s,c,a]=await Promise.all([window.conductor.permissions.getProfile(),window.conductor.dataControl.getSettings(),window.conductor.dataControl.listConsents(),window.conductor.settings.get('execution.autoApprove')]);setProfile(p);setSettings(s);setConsents(c);setAutoApprove(a === true); }
    catch(err){setError(err instanceof Error?err.message:'Could not load settings');}
  }
  useEffect(()=>{void refresh();},[]);
  async function perform(action:()=>Promise<unknown>,message:string):Promise<void> {
    setBusy(true);setError(null);setStatus('');
    try{reportMemoryCleanup(await action());setStatus(message);await refresh();}catch(err){setError(err instanceof Error?err.message:'Could not update settings');}finally{setBusy(false);}
  }
  const field='inset-field px-3 py-2 text-sm ';
  return <section className="flex flex-col gap-5" aria-label="Execution and data settings">
    <h2 className="text-sm font-semibold">Execution permissions</h2>
    <p className="text-sm text-muted-foreground">Read-only blocks agent command execution. Assisted execution lets agents start right away and asks you each time one wants to run a command, change files, or use another tool; reads and searches inside the workspace don’t ask. Trusted automation never asks. Changing the profile revokes current grants and cancels dependent work.</p>
    <label className="flex flex-col gap-2 text-sm">Permission profile
      <select className={field} value={profile} disabled={busy} onChange={(e)=>{const next=e.target.value as PermissionProfile;void perform(()=>window.conductor.permissions.setProfile(next),'Permission profile saved.');}}>
        <option value="read_only">Read-only</option><option value="assisted_execution">Assisted execution</option><option value="trusted_automation">Trusted automation</option>
      </select>
    </label>
    <div className="flex items-start gap-3 rounded-xl bg-muted/50 p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Auto-approve everything</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Commands, file changes, and other tool requests run without asking. Reads and searches never ask. This does not grant permission for data to leave your machine; provider consent above is still required.</p>
      </div>
      <Switch label="Auto-approve everything" checked={autoApprove} disabled={busy} onChange={(next)=>{void perform(()=>window.conductor.settings.set({key:'execution.autoApprove',value:next,scope:'global'}),next?'Auto-approve enabled.':'Auto-approve disabled.');}} />
    </div>
    <h2 className="text-sm font-semibold">External provider consent</h2>
    <p className="text-sm text-muted-foreground">Agent CLIs send your task and loaded context to their provider using your existing CLI login. Allow a provider here before starting tasks. Codex runs in a workspace sandbox; Claude Code is currently limited to reading files and responding.</p>
    <div className="flex flex-col gap-3">{providers.map((provider)=>{
      const allowed=consents.some((c)=>c.provider===provider.id);
      return <label key={provider.id} className="flex items-center gap-3 text-sm"><input type="checkbox" checked={allowed} disabled={busy} onChange={()=>{void perform(()=>allowed?window.conductor.dataControl.revokeConsent(provider.id):window.conductor.dataControl.grantConsent(provider.id),allowed?'Provider consent revoked.':'Provider consent granted.');}}/>{provider.label} — {allowed?'Allowed':'Blocked'}</label>;
    })}</div>
    <h2 className="text-sm font-semibold">Data preferences</h2>
    {settings ? <form className="flex flex-col gap-3" onSubmit={(e)=>{e.preventDefault();void perform(()=>window.conductor.dataControl.setSettings(settings),'Data preferences saved.');}}>
      <label className="flex flex-col gap-2 text-sm">Retention preference in days (0 keeps indefinitely)
        <input className={field} type="number" min="0" step="1" value={settings.retentionDays} onChange={(e)=>setSettings({...settings,retentionDays:Number(e.target.value)})}/>
      </label>
      <p className="text-xs text-muted-foreground">Retention is stored as a preference. Automatic expiry cleanup is not scheduled yet; use the deletion controls below for immediate removal.</p>
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={settings.indexingEnabled} onChange={(e)=>setSettings({...settings,indexingEnabled:e.target.checked})}/>Use saved context and indexed folders for new tasks</label>
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={settings.syncEnabled} onChange={(e)=>setSettings({...settings,syncEnabled:e.target.checked})}/>Keep indexed folders in sync automatically</label>
      <button className={field} disabled={busy} type="submit">Save preferences</button>
    </form>:<button className={field} type="button" onClick={()=>{void refresh();}}>Reload settings</button>}
    <h2 className="text-sm font-semibold">Delete stored data</h2>
    <div className="flex flex-wrap gap-3"><select aria-label="Data to delete" className={field} value={target} disabled={busy} onChange={(e)=>{setTarget(e.target.value as DataDeletionTarget);setConfirmDelete(false);}}>
      <option value="tasks">Task history</option><option value="context_items">Context items</option><option value="ingested_items">Ingested source items</option>
    </select><button type="button" className={field} disabled={busy} onClick={()=>setConfirmDelete(true)}>Delete…</button></div>
    {confirmDelete?<div className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3"><p className="text-sm">Permanently delete {target.replace(/_/g,' ')} from Conductor? This cannot be undone.</p><div className="flex gap-3"><button type="button" disabled={busy} className={field} onClick={()=>{void perform(async()=>{const result=await window.conductor.dataControl.delete(target);setConfirmDelete(false);if(target==='tasks'){useTaskStore.getState().clear();useApprovalStore.getState().clear();}return result;},'Stored data deleted.');}}>Confirm deletion</button><button type="button" className={field} onClick={()=>setConfirmDelete(false)}>Keep data</button></div></div>:null}
    {error?<p role="alert" className="text-sm text-destructive-foreground">{error}</p>:null}{status?<p role="status" className="text-sm text-success">{status}</p>:null}
  </section>;
}
