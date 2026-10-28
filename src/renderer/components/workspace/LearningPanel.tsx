import { useCallback, useEffect, useState } from 'react';
import type { AutoExecuteRule, ImprovementProposal } from '@shared/domain';
import type { AgentStat } from '@shared/integrations-contract';
import type { LearningConfig, LearningStatus } from '@shared/learning-contract';
import { LEARNING_INTERVAL_MS } from '@shared/learning-contract';
import { relativeTime, formatDuration } from '../../lib/time';
import { Badge, Button, Dialog, EmptyState, Switch, inputClassName } from '../ui/primitives';
import { BrainIcon } from '../ui/icons';
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
    <section aria-label="Learning" className="flex flex-col gap-6">
      {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
      {notice !== null ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}

      <div className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><BrainIcon size={14} className="text-muted-foreground" />Learning LLM</h2>
        <p className="text-xs text-muted-foreground">Approve one installed agent to analyze routing. It runs read-only over each agent&apos;s success rate and the recent audit log — it can only suggest routing, and every suggestion is checked against the measured evidence before it is proposed or applied.</p>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">Approved LLM (agent)</span>
          <select aria-label="Approved learning LLM" className={inputClassName} value={agentId} onChange={(e) => { setAgentId(e.target.value); setModel(''); }}>
            <option value="">Select an agent…</option>
            {agents.map((a) => <option key={a.id} value={a.id} disabled={!a.available}>{a.name} ({a.id}){a.available ? '' : ' — unavailable'}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">Model</span>
          <select aria-label="Learning LLM model" className={inputClassName} value={model} disabled={agentId === '' || catalog === null} onChange={(e) => { setModel(e.target.value); }}>
            <option value="">Default / Auto</option>
            {savedModelMissing ? <option value={model}>{model} (saved — not in this agent&apos;s catalog)</option> : null}
            {(catalog?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label} ({m.id}){m.isDefault ? ' — default' : ''} · {m.tier}</option>)}
          </select>
          {agentId !== '' && catalog !== null && catalog.models.length === 0 ? <span className="text-2xs text-muted-foreground">This agent reported no model list; Default / Auto will be used.</span> : null}
          {agentId !== '' && catalog === null ? <span className="text-2xs text-muted-foreground">Loading models…</span> : null}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="primary" disabled={busy || agentId === ''} onClick={() => { void save({ analyzerAgentId: agentId, analyzerModel: model }); }}>
            {approvedAgent === agentId && agentId !== '' ? 'Approved' : 'Approve this LLM'}
          </Button>
          {approvedAgent !== undefined ? <Badge tone="success">Approved: {approvedAgent}{config?.analyzerModel ? ` · ${config.analyzerModel}` : ''}</Badge> : <Badge tone="warning">No LLM approved — cron will skip</Badge>}
        </div>
        <p className="text-2xs text-muted-foreground">Changing the approved LLM or its model purges old routing approvals, so routing decided under the previous analyzer does not carry over.</p>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold text-foreground">Routing approval</h3>
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Routing approval mode">
          {([['manual', 'Manual approval', 'Each suggested routing waits below for your Approve / Reject.'], ['auto', 'Auto mode', 'Demonstrated routing is approved and applied automatically, then rolled back if results regress.']] as const).map(([mode, label, hint]) => (
            <label key={mode} className="flex cursor-pointer items-start gap-2 text-xs">
              <input type="radio" name="learning-mode" checked={(config?.mode ?? 'manual') === mode} onChange={() => { void save({ mode }); }} className="mt-0.5" />
              <span><span className="font-medium text-foreground">{label}</span><span className="block text-muted-foreground">{hint}</span></span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="flex items-center gap-2">
            <Switch label="Run learning every 5 minutes" checked={config?.enabled ?? true} onChange={(v) => { void save({ enabled: v }); }} />
            <span className="text-foreground">Run every {Math.round(LEARNING_INTERVAL_MS / 60_000)} minutes</span>
          </span>
          <Button size="xs" disabled={busy || status?.running === true} onClick={() => { void act(() => window.conductor.learning.runNow()); }}>{status?.running ? 'Analyzing…' : 'Run now'}</Button>
        </div>
        <p className="text-2xs text-muted-foreground">
          {status?.lastRun ? <>Last run {relativeTime(status.lastRun.finishedAt ?? status.lastRun.startedAt)} · {status.lastRun.status}{status.lastRun.detail ? ` · ${status.lastRun.detail}` : ''}</> : 'No learning run yet.'}
          {status?.nextRunAt && config?.enabled ? <> · Next run {relativeTime(status.nextRunAt)}</> : null}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-foreground">Agent success rate</h3>
        {stats.length > 0 ? (
          <table className="w-full text-left text-xs">
            <thead className="text-3xs tracking-wide text-muted-foreground uppercase"><tr><th className="py-1 font-medium">Agent</th><th className="py-1 font-medium">Tasks</th><th className="py-1 font-medium">Success</th><th className="py-1 font-medium">Avg time</th></tr></thead>
            <tbody>
              {stats.map((row) => (
                <tr key={row.adapterId} className="border-t border-border">
                  <td className="py-1.5 font-mono">{row.adapterId}</td>
                  <td className="py-1.5 tabular-nums">{row.stats.sampleSize}</td>
                  <td className="py-1.5 tabular-nums">{Math.round((1 - row.stats.failureRate) * 100)}%</td>
                  <td className="py-1.5 tabular-nums">{formatDuration(row.stats.meanDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-xs text-muted-foreground">No finished tasks recorded yet.</p>}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">Routing proposals</h3>
          <Button size="xs" variant="destructive-outline" disabled={busy || purgeable.length === 0} onClick={() => { setPurging(true); }}>
            Purge old routing approvals{purgeable.length > 0 ? ` (${purgeable.length})` : ''}
          </Button>
        </div>
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
          <ul className="flex flex-col gap-2">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-medium text-foreground">{proposal.summary}</p>
                  <Badge tone={STATUS_TONE[proposal.status]}>{proposal.status.replace('_', ' ')}</Badge>
                </div>
                <p className="mt-1 text-2xs text-muted-foreground">
                  Baseline {Math.round((1 - proposal.baseline.failureRate) * 100)}% success, {formatDuration(proposal.baseline.meanDurationMs)} over {proposal.baseline.sampleSize} tasks →
                  projected {Math.round((1 - proposal.projected.failureRate) * 100)}%, {formatDuration(proposal.projected.meanDurationMs)} · {relativeTime(proposal.createdAt)}
                </p>
                {proposal.status === 'proposed' ? (
                  <div className="mt-2 flex gap-1.5">
                    <Button size="xs" variant="primary" disabled={busy} onClick={() => { void act(() => window.conductor.learning.approve(proposal.id)); }}>Approve</Button>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void act(() => window.conductor.learning.reject(proposal.id)); }}>Reject</Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold text-foreground">Auto-run suggestions</h3>
        {rules.length === 0 ? <p className="mt-1 text-2xs text-muted-foreground">None. Choose “Always” on a suggestion to auto-run that kind of action when permissions allow.</p> : (
          <ul className="mt-1.5 flex flex-col gap-1">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 font-mono">{rule.actionKind}</span>
                <Button size="xs" variant="ghost" onClick={() => { void act(() => window.conductor.suggestions.removeRule(rule.actionKind)); }}>Stop auto-running</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
