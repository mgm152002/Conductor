import type { Skill, SkillUsage } from '@shared/domain';
import { Badge, EmptyState } from '../ui/primitives';

export interface SkillUsageHistoryProps {
  usages: SkillUsage[];
  skills: Skill[];
}

function outcomeTone(outcome: SkillUsage['outcome']): 'neutral' | 'success' | 'warning' | 'destructive' {
  if (outcome === 'completed') return 'success';
  if (outcome === 'failed') return 'destructive';
  if (outcome === 'skipped') return 'warning';
  return 'neutral';
}

export function SkillUsageHistory({ usages, skills }: SkillUsageHistoryProps): React.JSX.Element {
  const names = new Map(skills.map((skill) => [skill.id, skill.name]));
  const recent = [...usages].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));

  return (
    <section className="space-y-3" aria-labelledby="skill-usage-heading">
      <div>
        <h2 id="skill-usage-heading" className="text-sm font-semibold text-foreground">Usage history</h2>
        <p className="mt-0.5 text-2xs text-muted-foreground">Recent applications and skips remain here even after a binding is removed.</p>
      </div>

      {recent.length === 0 ? (
        <EmptyState
          title="No automation usage yet"
          description="Applications, skips, and their eventual outcomes will appear after an incoming task matches a vendor binding."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[42rem] text-left text-xs" aria-label="Skill usage history">
            <thead className="border-b border-border bg-muted/30 text-2xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Applied</th>
                <th className="px-3 py-2 font-medium">Skill</th>
                <th className="px-3 py-2 font-medium">Vendor key</th>
                <th className="px-3 py-2 font-medium">Triggering task</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {recent.map((usage) => (
                <tr key={usage.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    <time dateTime={usage.startedAt}>{new Date(usage.startedAt).toLocaleString()}</time>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-foreground">{names.get(usage.skillId) ?? 'Deleted skill'}</span>
                    <span className="ml-1 text-muted-foreground">v{usage.skillVersion}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs text-foreground">{usage.triggerKey}</td>
                  <td className="px-3 py-2 text-foreground">{usage.taskId ? `Task ${usage.taskId}` : 'No task recorded'}</td>
                  <td className="px-3 py-2"><Badge tone={outcomeTone(usage.outcome)}>{usage.outcome}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
