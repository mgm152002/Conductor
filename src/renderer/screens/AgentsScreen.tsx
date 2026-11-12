import { useCallback, useEffect, useMemo, useState } from 'react';
import { SANDBOX_AGENT_COLORS, type AgentGroup, type SandboxAgent, type SandboxAgentInput, type SandboxStatus } from '@shared/sandbox-agents';
import { useAgents } from '../hooks/useAgents';
import { useAgentActivity } from '../hooks/useAgentActivity';
import { useTaskStore } from '../stores';
import { useSandboxAgentStore } from '../stores/sandbox-agent-store';
import { threadKey } from '../lib/threads';
import { relativeTime } from '../lib/time';
import { cn } from '../lib/cn';
import { AgentAvatar } from '../components/ui/AgentAvatar';
import { Alert, Button, Dialog, inputClassName } from '../components/ui/primitives';
import { CheckIcon, DownloadIcon, PlusIcon, SearchIcon, Spinner, UsersIcon } from '../components/ui/icons';
import { AgentDialog, TEMPLATES, message } from '../components/agents/AgentDialog';
import { AgentChat, GroupAvatar, GroupChat } from '../components/agents/AgentChats';

// Agents, as a messenger: your agents and group chats on the left, the open
// conversation on the right. Talk to one agent, or to a group of them at once.

const rowClass = (selected: boolean): string => cn(
  'flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
  selected ? 'bg-sidebar-row-active shadow-lift' : 'hover:bg-sidebar-row-hover',
);

function AgentRow({ agent, selected, onSelect, lastAt, lastText }: {
  agent: SandboxAgent; selected: boolean; onSelect: () => void; lastAt?: string | undefined; lastText?: string | undefined;
}): React.JSX.Element {
  const activity = useAgentActivity(agent.id);
  const status = activity.mood === 'working' ? 'Working…' : activity.mood === 'waiting' ? 'Needs your approval' : undefined;
  return (
    <li>
      <button type="button" onClick={onSelect} aria-current={selected ? 'page' : undefined} className={rowClass(selected)}>
        <AgentAvatar agent={agent} size={38} mood={activity.mood} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-sidebar-foreground">{agent.name}</span>
            {lastAt !== undefined ? <span className="shrink-0 text-3xs text-sidebar-muted-foreground">{relativeTime(lastAt)}</span> : null}
          </span>
          <span className={cn('block truncate text-2xs', status !== undefined ? (activity.mood === 'waiting' ? 'font-medium text-amber-600 dark:text-amber-300' : 'text-info') : 'text-sidebar-muted-foreground')}>
            {status ?? lastText ?? agent.description}
          </span>
        </span>
      </button>
    </li>
  );
}

function GroupRow({ group, agents, selected, onSelect }: { group: AgentGroup; agents: SandboxAgent[]; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const members = group.agentIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is SandboxAgent => agent !== undefined);
  return (
    <li>
      <button type="button" onClick={onSelect} aria-current={selected ? 'page' : undefined} className={rowClass(selected)}>
        <GroupAvatar members={members} size={38} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-sidebar-foreground">{group.name}</span>
            <span className="shrink-0 text-3xs text-sidebar-muted-foreground">{relativeTime(group.updatedAt)}</span>
          </span>
          <span className="block truncate text-2xs text-sidebar-muted-foreground">{members.map((member) => member.name).join(', ')}</span>
        </span>
      </button>
    </li>
  );
}

/** One line about sandboxes; expands only when something needs doing. */
function SandboxBar({ status, onPull, onStop }: { status: SandboxStatus | null; onPull: () => void; onStop: (agentId: string) => void }): React.JSX.Element | null {
  if (status === null) return null;
  const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
  if (status.docker !== 'ready') {
    return <p className="rounded-xl bg-warning/10 px-3 py-2 text-2xs text-warning">{status.docker === 'not-installed' ? 'Install Docker to give agents a sandbox.' : 'Start Docker to give agents a sandbox.'}</p>;
  }
  if (status.image !== 'present') {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
        <p className="text-2xs text-muted-foreground">Agents need the sandbox (about 12 GB).</p>
        {status.pullError !== undefined ? <p className="text-2xs text-destructive-foreground">{status.pullError}</p> : null}
        {status.image === 'pulling' ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(3, (status.pullProgress ?? 0) * 100)}%` }} /></div>
        ) : <Button size="sm" variant="primary" onClick={onPull}><DownloadIcon size={13} />Download sandbox</Button>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 px-1 text-2xs text-sidebar-muted-foreground">
      <p className="flex items-center gap-1.5">
        <span className={cn('size-1.5 rounded-full', status.running.length > 0 ? 'bg-success' : 'bg-sidebar-muted-foreground/50')} />
        {status.running.length === 0 ? 'No sandboxes running' : `${status.running.length} sandbox${status.running.length === 1 ? '' : 'es'} running`}
        {status.memory !== undefined ? <span className="ml-auto tabular-nums" title="Docker memory in use">{gib(status.memory.used)} / {gib(status.memory.total)} GB</span> : null}
      </p>
      {status.running.map((run) => (
        <p key={run.agentId} className="flex items-center gap-1.5 pl-3">
          <span className="min-w-0 flex-1 truncate">{run.agentName}{run.state !== 'ready' ? ` (${run.state})` : ''}</span>
          <button type="button" onClick={() => { onStop(run.agentId); }} className="cursor-pointer rounded px-1 hover:bg-sidebar-row-hover hover:text-sidebar-foreground">Stop</button>
        </p>
      ))}
    </div>
  );
}

function NewGroupDialog({ agents, onClose, onCreated }: { agents: SandboxAgent[]; onClose: () => void; onCreated: (group: AgentGroup) => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create(): Promise<void> {
    setBusy(true); setError(null);
    try { onCreated(await window.conductor.sandboxAgents.createGroup({ name, agentIds: picked })); onClose(); }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="New group" width="max-w-md"
      footer={<>
        <Button size="md" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="md" variant="primary" disabled={busy || picked.length < 2} onClick={() => { void create(); }}>{busy ? <Spinner size={13} /> : null}Create group</Button>
      </>}>
      <div className="flex flex-col gap-3">
        <input className={inputClassName} value={name} maxLength={60} placeholder="Group name (optional)" aria-label="Group name" onChange={(e) => { setName(e.target.value); }} />
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto" aria-label="Members">
          {agents.map((agent) => {
            const on = picked.includes(agent.id);
            return (
              <li key={agent.id}>
                <button type="button" role="checkbox" aria-checked={on} onClick={() => { setPicked(on ? picked.filter((id) => id !== agent.id) : [...picked, agent.id]); }}
                  className={cn('flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring', on ? 'bg-primary/10' : 'hover:bg-accent')}>
                  <AgentAvatar agent={agent} size={30} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{agent.name}</span>
                  <span className={cn('flex size-5 items-center justify-center rounded-full border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong')}>{on ? <CheckIcon size={11} /> : null}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {agents.length < 2 ? <p className="text-xs text-muted-foreground">Create at least two agents first.</p> : null}
        {error !== null ? <Alert>{error}</Alert> : null}
      </div>
    </Dialog>
  );
}

export function AgentsScreen(): React.JSX.Element {
  const agents = useSandboxAgentStore((s) => s.agents);
  const groups = useSandboxAgentStore((s) => s.groups);
  const threads = useSandboxAgentStore((s) => s.threads);
  const groupThreads = useSandboxAgentStore((s) => s.groupThreads);
  const loaded = useSandboxAgentStore((s) => s.loaded);
  const refresh = useSandboxAgentStore((s) => s.refresh);
  const tasks = useTaskStore((s) => s.tasks);
  const clis = useAgents();
  const selection = useSandboxAgentStore((s) => s.selection);
  const select = useSandboxAgentStore((s) => s.select);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; input: SandboxAgentInput } | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [deleting, setDeleting] = useState<{ kind: 'agent' | 'group'; id: string; name: string } | null>(null);

  const loadStatus = useCallback(async () => {
    try { setStatus(await window.conductor.sandbox.status()); } catch { /* shown as unknown */ }
  }, []);
  useEffect(() => { void refresh(); void loadStatus(); }, [refresh, loadStatus]);
  // Chats without a project live in the hidden agent workspace, which the
  // project loaders skip; load them here.
  useEffect(() => {
    void window.conductor.sandboxAgents.workspace()
      .then((workspaceId) => window.conductor.task.list({ workspaceId, limit: 200 }))
      .then((list) => { useTaskStore.getState().setTasks(list); })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { void loadStatus(); }, status?.image === 'pulling' ? 1_500 : 8_000);
    return () => { window.clearInterval(timer); };
  }, [status?.image, loadStatus]);

  // Each agent's latest 1:1 message, for the list.
  const lastByAgent = useMemo(() => {
    const out = new Map<string, { at: string; text: string }>();
    for (const task of Object.values(tasks)) {
      const key = threadKey(task);
      const agentId = threads[key];
      if (agentId === undefined || key in groupThreads) continue;
      const prev = out.get(agentId);
      if (prev === undefined || task.updatedAt > prev.at) out.set(agentId, { at: task.updatedAt, text: task.objective.split('\n')[0] ?? '' });
    }
    return out;
  }, [tasks, threads, groupThreads]);

  const q = query.trim().toLowerCase();
  const shownGroups = groups.filter((group) => q === '' || group.name.toLowerCase().includes(q));
  const shownAgents = useMemo(() => [...agents]
    .filter((agent) => q === '' || agent.name.toLowerCase().includes(q))
    .sort((a, b) => (lastByAgent.get(b.id)?.at ?? b.createdAt).localeCompare(lastByAgent.get(a.id)?.at ?? a.createdAt)), [agents, q, lastByAgent]);
  const selectedAgent = selection?.kind === 'agent' ? agents.find((agent) => agent.id === selection.id) : undefined;
  const selectedGroup = selection?.kind === 'group' ? groups.find((group) => group.id === selection.id) : undefined;
  const defaultClis = clis.filter((cli) => cli.available && !cli.remote).map((cli) => cli.id);
  const blank = (): SandboxAgentInput => ({ name: '', description: '', instructions: '', clis: defaultClis, tools: ['browser', 'files'], approval: 'risky', color: SANDBOX_AGENT_COLORS[agents.length % SANDBOX_AGENT_COLORS.length]! });

  // Open the first conversation when nothing (or something deleted) is selected.
  const firstAgentId = shownAgents[0]?.id;
  useEffect(() => {
    if (!loaded || selectedAgent !== undefined || selectedGroup !== undefined || firstAgentId === undefined) return;
    select({ kind: 'agent', id: firstAgentId });
  }, [loaded, selectedAgent, selectedGroup, firstAgentId, select]);

  return (
    <div data-screen="agents" className="flex h-full min-h-0">
      <aside aria-label="Conversations" className="flex w-[300px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex h-14 shrink-0 items-center gap-1 px-4">
          <h1 className="flex-1 font-display text-[17px] font-semibold text-sidebar-foreground">Agents</h1>
          <Button size="icon" variant="ghost" aria-label="New group" title={agents.length < 2 ? 'Create two agents to start a group' : 'New group'} disabled={agents.length < 2} onClick={() => { setCreatingGroup(true); }}><UsersIcon size={16} /></Button>
          <Button size="icon" variant="ghost" aria-label="New agent" title="New agent" onClick={() => { setEditing({ id: null, input: blank() }); }}><PlusIcon size={16} /></Button>
        </div>
        <div className="px-3 pb-2">
          <label className="flex h-8 items-center gap-2 rounded-lg bg-sidebar-row-hover px-2.5 text-sidebar-muted-foreground focus-within:text-sidebar-foreground">
            <SearchIcon size={13} />
            <span className="sr-only">Search</span>
            <input value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground" />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {shownGroups.length > 0 ? (
            <>
              <h2 className="px-2.5 pt-2 pb-1 text-2xs font-semibold text-sidebar-muted-foreground">Groups</h2>
              <ul className="flex flex-col gap-0.5">
                {shownGroups.map((group) => <GroupRow key={group.id} group={group} agents={agents} selected={selectedGroup?.id === group.id} onSelect={() => { select({ kind: 'group', id: group.id }); }} />)}
              </ul>
            </>
          ) : null}
          {shownAgents.length > 0 ? (
            <>
              {shownGroups.length > 0 ? <h2 className="px-2.5 pt-3 pb-1 text-2xs font-semibold text-sidebar-muted-foreground">Agents</h2> : null}
              <ul className="flex flex-col gap-0.5">
                {shownAgents.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} selected={selectedAgent?.id === agent.id} onSelect={() => { select({ kind: 'agent', id: agent.id }); }}
                    lastAt={lastByAgent.get(agent.id)?.at} lastText={lastByAgent.get(agent.id)?.text} />
                ))}
              </ul>
            </>
          ) : null}
          {loaded && agents.length === 0 ? (
            <ul className="flex flex-col gap-1 pt-1" aria-label="Templates">
              <li className="px-2.5 pb-1 text-2xs font-semibold text-sidebar-muted-foreground">Start from</li>
              {TEMPLATES.map((template) => (
                <li key={template.name}>
                  <button type="button" onClick={() => { setEditing({ id: null, input: { ...template, clis: defaultClis } }); }} className={rowClass(false)}>
                    <AgentAvatar agent={template} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-sidebar-foreground">{template.name}</span>
                      <span className="block truncate text-2xs text-sidebar-muted-foreground">{template.description}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="shrink-0 border-t border-sidebar-border p-3">
          <SandboxBar
            status={status}
            onPull={() => { void window.conductor.sandbox.pull().then(setStatus).catch((err: unknown) => { setError(message(err)); }); }}
            onStop={(agentId) => { void window.conductor.sandbox.stop(agentId).then(loadStatus).catch((err: unknown) => { setError(message(err)); }); }}
          />
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error !== null ? <div className="px-4 pt-3"><Alert action={<Button size="xs" variant="ghost" onClick={() => { setError(null); }}>Dismiss</Button>}>{error}</Alert></div> : null}
        {selectedAgent !== undefined ? (
          <AgentChat
            agent={selectedAgent}
            sandboxRunning={status?.running.some((run) => run.agentId === selectedAgent.id && run.state === 'ready') === true}
            onEdit={() => { setEditing({ id: selectedAgent.id, input: { name: selectedAgent.name, description: selectedAgent.description, instructions: selectedAgent.instructions, clis: selectedAgent.clis, models: selectedAgent.models, tools: selectedAgent.tools, approval: selectedAgent.approval, color: selectedAgent.color } }); }}
            onDelete={() => { setDeleting({ kind: 'agent', id: selectedAgent.id, name: selectedAgent.name }); }}
          />
        ) : selectedGroup !== undefined ? (
          <GroupChat group={selectedGroup} agents={agents} onDelete={() => { setDeleting({ kind: 'group', id: selectedGroup.id, name: selectedGroup.name }); }} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm font-semibold text-foreground">{loaded && agents.length === 0 ? 'Create your first agent' : 'Pick a conversation'}</p>
            {loaded && agents.length === 0 ? <Button size="md" variant="primary" onClick={() => { setEditing({ id: null, input: blank() }); }}><PlusIcon size={14} />New agent</Button> : null}
          </div>
        )}
      </main>

      {editing !== null ? (
        <AgentDialog open initial={editing.input} editingId={editing.id} clis={clis} onClose={() => { setEditing(null); }}
          onSaved={(agent) => { void refresh(); select({ kind: 'agent', id: agent.id }); }} />
      ) : null}
      {creatingGroup ? <NewGroupDialog agents={agents} onClose={() => { setCreatingGroup(false); }} onCreated={(group) => { void refresh(); select({ kind: 'group', id: group.id }); }} /> : null}
      <Dialog
        open={deleting !== null}
        onClose={() => { setDeleting(null); }}
        title={`Delete ${deleting?.name ?? ''}?`}
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { setDeleting(null); }}>Keep</Button>
          <Button size="md" variant="destructive" onClick={() => {
            const target = deleting;
            setDeleting(null);
            if (target === null) return;
            const run = target.kind === 'agent' ? window.conductor.sandboxAgents.remove(target.id) : window.conductor.sandboxAgents.removeGroup(target.id);
            void run.then(() => { select(null); return refresh(); }).catch((err: unknown) => { setError(message(err)); });
          }}>Delete</Button>
        </>}
      />
    </div>
  );
}
