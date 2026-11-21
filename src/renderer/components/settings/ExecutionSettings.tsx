import { useTaskStore, useApprovalStore } from '../../stores';
import { useEffect, useState } from 'react';
import { reportMemoryCleanup } from '../../lib/memory-cleanup';
import type { DataControlSettings, DataDeletionTarget, ExternalFlowConsent, PermissionProfile } from '@shared/domain';
import { Button, Dialog, Switch, inputClassName } from '../ui/primitives';
import { cn } from '../../lib/cn';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
import { MenuSelect } from '../ui/MenuSelect';

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
  const labelOf=(t:DataDeletionTarget):string=>t==='tasks'?'task history':t==='context_items'?'context items':'ingested source items';
  // Settings shape: titled sections of grouped rows, control on the right.
  return <section className="flex flex-col gap-8" aria-label="Execution and data settings">
    <SettingsSection title="Execution permissions">
      <SettingsGroup>
        <SettingsRow title="Permission profile" description="How much agents may do on this Mac without asking."
          control={<MenuSelect variant="box" className="w-full sm:w-56" label="Permission profile" value={profile} disabled={busy} onChange={(next)=>{void perform(()=>window.conductor.permissions.setProfile(next as PermissionProfile),'Permission profile saved.');}} options={[
            { value: 'read_only', label: 'Read-only' },
            { value: 'assisted_execution', label: 'Assisted execution' },
            { value: 'trusted_automation', label: 'Trusted automation' },
          ]} />} />
        <SettingsRow title="Auto-approve everything" description="Approve every agent request without asking. Use with care."
          control={<Switch label="Auto-approve everything" checked={autoApprove} disabled={busy} onChange={(next)=>{void perform(()=>window.conductor.settings.set({key:'execution.autoApprove',value:next,scope:'global'}),next?'Auto-approve enabled.':'Auto-approve disabled.');}} />} />
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection title="External provider consent">
      <SettingsGroup>
        {providers.map((provider)=>{
          const allowed=consents.some((c)=>c.provider===provider.id);
          return <SettingsRow key={provider.id} title={provider.label} description={allowed?'Allowed to receive task context.':'Blocked from receiving task context.'}
            control={<Switch label={`Allow ${provider.label}`} checked={allowed} disabled={busy} onChange={()=>{void perform(()=>allowed?window.conductor.dataControl.revokeConsent(provider.id):window.conductor.dataControl.grantConsent(provider.id),allowed?'Provider consent revoked.':'Provider consent granted.');}} />} />;
        })}
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection title="Data preferences"
      action={settings ? <Button size="sm" variant="outline" disabled={busy} onClick={()=>{void perform(()=>window.conductor.dataControl.setSettings(settings),'Data preferences saved.');}}>Save preferences</Button> : undefined}>
      {settings ? <SettingsGroup>
        <SettingsRow title="Retention" description="Days to keep task history. 0 keeps it forever."
          control={<input aria-label="Retention in days" className={cn(inputClassName,'w-24 text-right tabular-nums')} type="number" min="0" step="1" value={settings.retentionDays} onChange={(e)=>setSettings({...settings,retentionDays:Number(e.target.value)})}/>} />
        <SettingsRow title="Use saved context for new tasks" description="Give new tasks the context Conductor has indexed."
          control={<Switch label="Use saved context for new tasks" checked={settings.indexingEnabled} onChange={(v)=>setSettings({...settings,indexingEnabled:v})} />} />
        <SettingsRow title="Sync indexed folders automatically" description="Keep indexed folders up to date in the background."
          control={<Switch label="Sync indexed folders automatically" checked={settings.syncEnabled} onChange={(v)=>setSettings({...settings,syncEnabled:v})} />} />
      </SettingsGroup> : <SettingsGroup><SettingsRow title="Could not load preferences" control={<Button size="sm" variant="outline" onClick={()=>{void refresh();}}>Reload settings</Button>} /></SettingsGroup>}
    </SettingsSection>

    <SettingsSection title="Delete stored data">
      <SettingsGroup>
        <SettingsRow title="Delete" description="Permanently remove the chosen data from this Mac."
          control={<>
            <MenuSelect variant="box" className="w-44" label="Data to delete" value={target} disabled={busy} onChange={(next)=>{setTarget(next as DataDeletionTarget);setConfirmDelete(false);}} options={[
              { value: 'tasks', label: 'Task history' },
              { value: 'context_items', label: 'Context items' },
              { value: 'ingested_items', label: 'Ingested source items' },
            ]} />
            <Button size="sm" variant="destructive-outline" disabled={busy} onClick={()=>setConfirmDelete(true)}>Delete…</Button>
          </>} />
      </SettingsGroup>
    </SettingsSection>
    <Dialog open={confirmDelete} onClose={()=>{ if(!busy) setConfirmDelete(false); }} title={`Delete ${labelOf(target)}?`} description="This permanently deletes it from this Mac. It can't be undone."
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={()=>setConfirmDelete(false)}>Keep data</Button>
        <Button variant="destructive" disabled={busy} onClick={()=>{void perform(async()=>{const result=await window.conductor.dataControl.delete(target);setConfirmDelete(false);if(target==='tasks'){useTaskStore.getState().clear();useApprovalStore.getState().clear();}return result;},'Stored data deleted.');}}>Confirm deletion</Button>
      </>} />
    {error?<p role="alert" className="px-3 text-sm text-destructive-foreground sm:px-4">{error}</p>:null}{status?<p role="status" className="px-3 text-sm text-success sm:px-4">{status}</p>:null}
  </section>;
}
