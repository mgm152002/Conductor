import { useCallback, useEffect, useState } from 'react';
import { SettingsGroup, SettingsRow, SettingsSection } from '../settings/SettingsLayout';
import { MenuSelect } from '../ui/MenuSelect';
import { BrandMark, ProviderAvatar, agentBrand, modelBrand } from '../ui/BrandMarks';
import { agentLabel } from '../../lib/usage-format';
import type { AutoExecuteRule, ImprovementProposal } from '@shared/domain';
import type { AgentStat } from '@shared/integrations-contract';
import type { LearningConfig, LearningStatus } from '@shared/learning-contract';
import { LEARNING_INTERVAL_MS } from '@shared/learning-contract';
import { relativeTime, formatDuration } from '../../lib/time';
import { Badge, Button, Dialog, EmptyState, Switch } from '../ui/primitives';
import { BrainIcon, SparklesIcon } from '../ui/icons';
import type { AgentOption } from '@shared/integrations-contract';
import { useAgentModels } from '../../hooks/useAgentModels';

// Learning: every 5 minutes the user-approved LLM reviews per-agent logs and
// success rates and figures out routing. Manual mode keeps every routing
// change as a proposal until the user approves it; auto mode applies
// demonstrated routing immediately (still rolled back on regression).

const STATUS_TONE: Record<ImprovementProposal['status'], 'primary' | 'success' | 'neutral' | 'warning'> = {
  proposed: 'primary', approved: 'success', rejected: 'neutral', rolled_back: 'warning',
};

export function LearningPanel(): React.JSX.Element {
  const [stats, setStats] = useState<AgentStat[]>([]);
  const [proposals, setProposals] = useState<ImprovementProposal[]>([]);
  const [rules, setRules] = useState<AutoExecuteRule[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [busy, setBusy] = useState(false);
  const catalog = useAgentModels(agentId !== '' ? agentId : undefined);

  const refresh = useCallback(async () => {
    try {
      const [s, p, r, a, st] = await Promise.all([
        window.conductor.learning.stats(), window.conductor.learning.proposals(),
        window.conductor.suggestions.rules(), window.conductor.agents.list(), window.conductor.learning.status(),
      ]);
      setStats(s); setProposals(p); setRules(r); setAgents(a); setStatus(st);
      setAgentId((cur) => cur || st.config.analyzerAgentId || '');
      setModel((cur) => cur || st.config.analyzerModel || '');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // Keep last-run / next-run fresh while the tab is open; the cron is 5-minly.
  useEffect(() => {
    const t = window.setInterval(() => { void window.conductor.learning.status().then(setStatus).catch(() => undefined); }, 30_000);
    return () => { window.clearInterval(t); };
  }, []);

  async function act(run: () => Promise<unknown>): Promise<void> {
    setError(null); setBusy(true);
    try { await run(); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  const save = (patch: Partial<LearningConfig>): Promise<unknown> => act(() => window.conductor.learning.setConfig(patch));
  const config = status?.config;
  const approvedAgent = config?.analyzerAgentId;
  // Old routing approvals: pending proposals plus approved rules in effect.
  const purgeable = proposals.filter((p) => p.kind === 'routing_rule' && (p.status === 'proposed' || p.status === 'approved'));
  const savedModelMissing = model !== '' && catalog !== null && !catalog.models.some((m) => m.id === model);

  async function purge(): Promise<void> {
    setError(null); setBusy(true);
    try {
      const result = await window.conductor.learning.purgeRoutingApprovals();
      setNotice(`Purged ${result.removed} old routing approval${result.removed === 1 ? '' : 's'}. Routing is back to default until new proposals are approved.`);
      setPurging(false);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setPurging(false); } finally { setBusy(false); }
  }

  return (
    // Settings shape: titled sections, each a rounded group of rows
    // with the control on the right.
    <section aria-label="Learning" className="flex flex-col gap-8">
      {error !== null ? <p role="alert" className="px-3 text-xs text-destructive-foreground sm:px-4">{error}</p> : null}
      {notice !== null ? <p role="status" className="px-3 text-xs text-muted-foreground sm:px-4">{notice}</p> : null}

      <SettingsSection title={<><BrainIcon size={14} className="text-muted-foreground" />Learning LLM</>}
        action={approvedAgent !== undefined ? <Badge tone="success">Approved: {approvedAgent}{config?.analyzerModel ? ` · ${config.analyzerModel}` : ''}</Badge> : <Badge tone="warning">No LLM approved — cron will skip</Badge>}>
        <SettingsGroup>
          <SettingsRow title="Approved LLM" description="The agent that reviews finished tasks and proposes routing changes."
            control={(
              <MenuSelect variant="box" label="Approved learning LLM" className="w-full sm:w-64" value={agentId} onChange={(next) => { setAgentId(next); setModel(''); }} options={[
                { value: '', label: 'Select an agent…' },
                ...agents.map((a) => ({ value: a.id, label: `${a.name} (${a.id})`, disabled: !a.available, ...(a.available ? {} : { hint: 'Unavailable' }), mark: <ProviderAvatar brand={agentBrand(a.id)} label={a.name} size={13} /> })),
              ]} />
            )} />
          <SettingsRow title="Model"
            description={agentId !== '' && catalog !== null && catalog.models.length === 0 ? 'This agent reported no model list; Default / Auto will be used.' : agentId !== '' && catalog === null ? 'Loading models…' : 'Default / Auto lets the agent pick.'}
            control={(
              <MenuSelect variant="box" searchable label="Learning LLM model" className="w-full sm:w-64" value={model} disabled={agentId === '' || catalog === null} onChange={setModel} options={[
                { value: '', label: 'Default / Auto', mark: <SparklesIcon size={13} /> },
                ...(savedModelMissing ? [{ value: model, label: model, hint: 'Saved — not in catalog' }] : []),
                ...(catalog?.models ?? []).map((m) => ({ value: m.id, label: `${m.label} (${m.id})`, hint: `${m.isDefault ? 'Default · ' : ''}${m.tier}`, mark: <ProviderAvatar brand={modelBrand(m.id)} label={m.label} size={13} /> })),
              ]} />
            )} />
          <SettingsRow title="Approve" description="Only an approved LLM runs; changing the agent or model needs approval again."
            control={(
              <Button size="sm" variant="primary" disabled={busy || agentId === ''} onClick={() => { void save({ analyzerAgentId: agentId, analyzerModel: model }); }}>
                {approvedAgent === agentId && agentId !== '' ? 'Approved' : 'Approve this LLM'}
              </Button>
            )} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Routing approval">
        <SettingsGroup>
          <div role="radiogroup" aria-label="Routing approval mode" className="flex flex-col *:not-first:border-t *:not-first:border-border/50">
            {([['manual', 'Manual approval', 'Each suggested routing waits below for your Approve / Reject.'], ['auto', 'Auto mode', 'Demonstrated routing is approved and applied automatically, then rolled back if results regress.']] as const).map(([mode, label, hint]) => (
              <label key={mode} className="flex cursor-pointer items-start gap-3 px-3 py-3 sm:px-4">
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block text-sm font-medium text-foreground">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
                <input type="radio" name="learning-mode" checked={(config?.mode ?? 'manual') === mode} onChange={() => { void save({ mode }); }} className="mt-1 accent-primary" />
              </label>
            ))}
          </div>
          <SettingsRow title={`Run every ${Math.round(LEARNING_INTERVAL_MS / 60_000)} minutes`}
            description={<>
              {status?.lastRun ? <>Last run {relativeTime(status.lastRun.finishedAt ?? status.lastRun.startedAt)} · {status.lastRun.status}{status.lastRun.detail ? ` · ${status.lastRun.detail}` : ''}</> : 'No learning run yet.'}
              {status?.nextRunAt && config?.enabled ? <> · Next run {relativeTime(status.nextRunAt)}</> : null}
            </>}
            control={(
              <>
                <Button size="sm" variant="outline" disabled={busy || status?.running === true} onClick={() => { void act(() => window.conductor.learning.runNow()); }}>{status?.running ? 'Analyzing…' : 'Run now'}</Button>
                <Switch label="Run learning every 5 minutes" checked={config?.enabled ?? true} onChange={(v) => { void save({ enabled: v }); }} />
              </>
            )} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Agent success rate">
        <SettingsGroup>
          {stats.length > 0 ? (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground"><tr className="border-b border-border/50"><th className="px-3 py-2.5 font-normal sm:px-4">Agent</th><th className="px-3 py-2.5 text-end font-normal">Tasks</th><th className="px-3 py-2.5 text-end font-normal">Success</th><th className="px-3 py-2.5 text-end font-normal sm:px-4">Avg time</th></tr></thead>
              <tbody>
                {stats.map((row) => (
                  <tr key={row.adapterId} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2.5 sm:px-4"><span className="flex items-center gap-2"><BrandMark brand={agentBrand(row.adapterId)} size={16} />{agentLabel(row.adapterId)}</span></td>
                    <td className="px-3 py-2.5 text-end tabular-nums">{row.stats.sampleSize}</td>
                    <td className="px-3 py-2.5 text-end tabular-nums">{Math.round((1 - row.stats.failureRate) * 100)}%</td>
                    <td className="px-3 py-2.5 text-end tabular-nums sm:px-4">{formatDuration(row.stats.meanDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">No finished tasks recorded yet.</p>}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Routing proposals"
        action={(
          <Button size="xs" variant="destructive-outline" disabled={busy || purgeable.length === 0} onClick={() => { setPurging(true); }}>
            Purge old routing approvals{purgeable.length > 0 ? ` (${purgeable.length})` : ''}
          </Button>
        )}>
        <Dialog
          open={purging}
          onClose={() => { if (!busy) setPurging(false); }}
          title="Purge old routing approvals?"
          description="This deletes pending and approved routing rules so none of them keep steering tasks. Rejected and rolled-back history is kept, and new proposals can be generated on the next learning run. This can't be undone."
          footer={(
            <>
              <Button variant="ghost" disabled={busy} onClick={() => { setPurging(false); }}>Cancel</Button>
              <Button variant="destructive" disabled={busy} onClick={() => { void purge(); }}>{busy ? 'Purging…' : `Purge ${purgeable.length}`}</Button>
            </>
          )}
        />
        {proposals.length === 0 ? <EmptyState title="No proposals yet" description="A proposal appears when the learning LLM finds a demonstrated improvement (at least 5 comparable prior tasks and a measured winner)." /> : (
          <SettingsGroup>
            {proposals.map((proposal) => (
              <SettingsRow key={proposal.id}
                title={<span className="flex flex-wrap items-center gap-2">{proposal.summary}<Badge tone={STATUS_TONE[proposal.status]}>{proposal.status.replace('_', ' ')}</Badge></span>}
                description={<>
                  Baseline {Math.round((1 - proposal.baseline.failureRate) * 100)}% success, {formatDuration(proposal.baseline.meanDurationMs)} over {proposal.baseline.sampleSize} tasks →
                  projected {Math.round((1 - proposal.projected.failureRate) * 100)}%, {formatDuration(proposal.projected.meanDurationMs)} · {relativeTime(proposal.createdAt)}
                </>}
                {...(proposal.status === 'proposed' ? {
                  control: (
                    <>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void act(() => window.conductor.learning.reject(proposal.id)); }}>Reject</Button>
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void act(() => window.conductor.learning.approve(proposal.id)); }}>Approve</Button>
                    </>
                  ),
                } : {})} />
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>

      <SettingsSection title="Auto-run suggestions">
        <SettingsGroup>
          {rules.length === 0 ? <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">None. Suggestions you mark “always run” appear here.</p> : rules.map((rule) => (
            <SettingsRow key={rule.id} title={<span className="font-mono text-xs">{rule.actionKind}</span>}
              control={<Button size="sm" variant="ghost" onClick={() => { void act(() => window.conductor.suggestions.removeRule(rule.actionKind)); }}>Stop auto-running</Button>} />
          ))}
        </SettingsGroup>
      </SettingsSection>
    </section>
  );
}
