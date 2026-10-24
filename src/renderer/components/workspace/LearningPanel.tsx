import { useCallback, useEffect, useState } from 'react';
import type { AutoExecuteRule, ImprovementProposal } from '@shared/domain';
import type { AgentStat } from '@shared/integrations-contract';
import { relativeTime, formatDuration } from '../../lib/time';
import { Badge, Button, EmptyState } from '../ui/primitives';
import { SparklesIcon } from '../ui/icons';

// Self-learning: how each agent has performed on finished tasks, routing
// improvements Conductor proposes from that evidence (applied only after you
// approve, rolled back automatically if results get worse), and the
// suggestion kinds you chose to auto-run.

const STATUS_TONE: Record<ImprovementProposal['status'], 'primary' | 'success' | 'neutral' | 'warning'> = {
  proposed: 'primary', approved: 'success', rejected: 'neutral', rolled_back: 'warning',
};

export function LearningPanel(): React.JSX.Element {
  const [stats, setStats] = useState<AgentStat[]>([]);
  const [proposals, setProposals] = useState<ImprovementProposal[]>([]);
  const [rules, setRules] = useState<AutoExecuteRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [s, p, r] = await Promise.all([window.conductor.learning.stats(), window.conductor.learning.proposals(), window.conductor.suggestions.rules()]);
      setStats(s); setProposals(p); setRules(r);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function act(run: () => Promise<unknown>): Promise<void> {
    setError(null);
    try { await run(); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  return (
    <section aria-label="Learning" className="flex flex-col gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><SparklesIcon size={14} className="text-muted-foreground" />Learning</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Finished tasks are recorded. When one agent clearly does better on comparable tasks, Conductor proposes preferring it. Nothing changes until you approve, and an approved change is rolled back if results get worse.</p>
      </div>
      {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
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
      {proposals.length === 0 ? <EmptyState title="No proposals yet" description="A proposal appears after enough comparable tasks show a measurable improvement (at least 5 prior tasks)." /> : (
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
                  <Button size="xs" variant="primary" onClick={() => { void act(() => window.conductor.learning.approve(proposal.id)); }}>Approve</Button>
                  <Button size="xs" variant="ghost" onClick={() => { void act(() => window.conductor.learning.reject(proposal.id)); }}>Reject</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
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
