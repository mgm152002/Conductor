import type { Skill, SkillBinding, SkillBindingStatus, SkillUsage } from '@shared/domain';
import { Alert, Badge, Button, Dialog, EmptyState } from '../ui/primitives';
import { Spinner } from '../ui/icons';
import { SkillUsageHistory } from './SkillUsageHistory';

export interface SkillAutomationPanelProps {
  bindings: SkillBinding[];
  usages: SkillUsage[];
  skills: Skill[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  removalCandidate: SkillBinding | null;
  onRetry: () => void;
  onShowSkills: () => void;
  onSetStatus: (bindingId: string, status: SkillBindingStatus) => void;
  onRequestRemove: (binding: SkillBinding) => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}

function lastUse(binding: SkillBinding): React.ReactNode {
  if (!binding.lastUsedAt) return 'Never';
  return <time dateTime={binding.lastUsedAt}>{new Date(binding.lastUsedAt).toLocaleString()}</time>;
}

export function SkillAutomationPanel({
  bindings,
  usages,
  skills,
  loading,
  error,
  busyId,
  removalCandidate,
  onRetry,
  onShowSkills,
  onSetStatus,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove,
}: SkillAutomationPanelProps): React.JSX.Element {
  const names = new Map(skills.map((skill) => [skill.id, skill]));
  const mutating = busyId !== null;

  if (loading) {
    return (
      <div role="status" className="flex min-h-48 items-center justify-center gap-2 rounded-xl border border-border text-xs text-muted-foreground">
        <Spinner size={14} />
        Loading automation bindings and usage…
      </div>
    );
  }

  if (error !== null) {
    return (
      <Alert tone="destructive" action={<Button variant="destructive-outline" size="xs" onClick={onRetry}>Retry automation</Button>}>
        Automation could not be loaded: {error}
      </Alert>
    );
  }

  return (
    <div className="space-y-7">
      <section className="space-y-3" aria-labelledby="automation-bindings-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="automation-bindings-heading" className="text-sm font-semibold text-foreground">Automation bindings</h2>
            <p className="mt-0.5 text-2xs text-muted-foreground">Vendor keys automatically select the current version of their learned skill.</p>
          </div>
          <Button variant="outline" size="xs" onClick={onRetry} disabled={mutating}>Refresh</Button>
        </div>

        {bindings.length === 0 ? (
          <EmptyState
            title="No automation bindings yet"
            description="Create or learn a vendor skill first. Conductor will show its automatic vendor match here."
          >
            <Button variant="primary" size="sm" onClick={onShowSkills}>View skills</Button>
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[48rem] text-left text-xs" aria-label="Automation bindings">
              <thead className="border-b border-border bg-muted/30 text-2xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Vendor key</th>
                  <th className="px-3 py-2 font-medium">Skill</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Current version</th>
                  <th className="px-3 py-2 font-medium">Last use</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {bindings.map((binding) => {
                  const skill = names.get(binding.skillId);
                  const rowBusy = busyId === binding.id;
                  return (
                    <tr key={binding.id}>
                      <td className="px-3 py-2">
                        <div className="font-mono text-2xs text-foreground">{binding.trigger.key}</div>
                        {binding.trigger.aliases.length > 0 ? <div className="mt-0.5 text-3xs text-muted-foreground">Aliases: {binding.trigger.aliases.join(', ')}</div> : null}
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground">{skill?.name ?? 'Deleted skill'}</td>
                      <td className="px-3 py-2"><Badge tone={binding.status === 'active' ? 'success' : 'neutral'}>{binding.status}</Badge></td>
                      <td className="px-3 py-2 text-foreground">{skill ? `v${skill.currentVersion}` : 'Unavailable'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{lastUse(binding)}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={mutating}
                            onClick={() => onSetStatus(binding.id, binding.status === 'active' ? 'disabled' : 'active')}
                          >
                            {rowBusy ? 'Working…' : binding.status === 'active' ? 'Disable' : 'Enable'}
                          </Button>
                          <Button variant="destructive-outline" size="xs" disabled={mutating} onClick={() => onRequestRemove(binding)}>Remove</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <SkillUsageHistory usages={usages} skills={skills} />

      <Dialog
        open={removalCandidate !== null}
        onClose={mutating ? () => undefined : onCancelRemove}
        title="Remove automation binding?"
        description="New tasks will stop using this vendor binding. Existing usage history will be preserved."
        footer={(
          <>
            <Button variant="ghost" disabled={mutating} onClick={onCancelRemove}>Cancel</Button>
            <Button variant="destructive" disabled={mutating} onClick={onConfirmRemove}>{mutating ? 'Removing…' : 'Remove binding'}</Button>
          </>
        )}
      >
        {removalCandidate ? (
          <p className="text-xs text-muted-foreground">Vendor key <span className="font-mono text-foreground">{removalCandidate.trigger.key}</span> will no longer trigger this skill.</p>
        ) : null}
      </Dialog>
    </div>
  );
}
