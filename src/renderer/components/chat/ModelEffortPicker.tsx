import { useId } from 'react';
import type { RunChoice } from '@shared/agent-models';
import { useAgentModels } from '../../hooks/useAgentModels';
import { cn } from '../../lib/cn';
import { ChevronDownIcon } from '../ui/icons';

// Model and reasoning-effort pickers for one agent. "Auto" lets Conductor pick
// by how demanding the work is (a cheaper model and lower effort for quick
// requests). The lists come from the agent CLI itself.

const pill = 'h-7 cursor-pointer appearance-none truncate rounded-full bg-transparent pr-6 pl-2.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-60';
const box = 'h-7 w-full cursor-pointer appearance-none truncate rounded-md border border-border bg-transparent pr-6 pl-2 text-xs text-foreground outline-none focus-visible:border-ring';

export const EFFORT_LABELS: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

export function ModelEffortPicker({ agentId, value, onChange, variant = 'pill', label }: {
  agentId: string;
  value: RunChoice;
  onChange: (value: RunChoice) => void;
  variant?: 'pill' | 'box';
  /** Accessible label prefix, e.g. "Planner". */
  label?: string;
}): React.JSX.Element {
  const catalog = useAgentModels(agentId);
  const modelId = useId();
  const effortId = useId();
  const models = catalog?.models ?? [];
  const selected = models.find((m) => m.id === value.model);
  // Effort levels the selected model accepts, mirroring run resolution:
  // support is per model (a model carries its own list iff the CLI accepts
  // `--effort` for it). Agent-level efforts are offered only on Auto, when no
  // model is pinned; a specific model is never assumed to inherit them.
  const efforts = value.model === undefined ? catalog?.efforts ?? [] : selected?.efforts ?? [];
  const cls = variant === 'pill' ? pill : box;
  const loading = catalog === null;
  const set = (patch: { model?: string | undefined; effort?: string | undefined }): void => {
    const next = { ...value, ...patch } as { model?: string | undefined; effort?: string | undefined };
    for (const key of ['model', 'effort'] as const) if (next[key] === undefined || next[key] === '') delete next[key];
    // Drop an effort the newly chosen model doesn't accept, by the same rule
    // as the dropdown above: agent-level efforts apply only on Auto (no model
    // pinned); a specific model offers only its own list.
    if (next.effort !== undefined) {
      const nextModel = models.find((m) => m.id === next.model);
      const nextSupported = next.model === undefined ? catalog?.efforts ?? [] : nextModel?.efforts ?? [];
      if (!nextSupported.includes(next.effort)) delete next.effort;
    }
    onChange(next as RunChoice);
  };
  const tierNote = (tier: string): string => (tier === 'economy' ? ' · cheaper' : tier === 'premium' ? ' · most capable' : '');

  return (
    <div className={cn('flex min-w-0 max-w-full flex-wrap items-center', variant === 'pill' ? 'gap-0' : 'flex-1 gap-1.5')}>
      <div className={cn('relative min-w-0 max-w-full', variant === 'box' && 'basis-36 flex-1')}>
        <label htmlFor={modelId} className="sr-only">{label ? `${label} model` : 'Model'}</label>
        <select
          id={modelId}
          value={value.model ?? ''}
          disabled={loading || models.length === 0}
          title={catalog?.error ?? (models.length === 0 && !loading ? 'This agent does not list its models; it uses its own default' : 'Model. Auto picks a cheaper model for quick requests.')}
          onChange={(e) => { set({ model: e.target.value || undefined }); }}
          className={cn(cls, variant === 'pill' && 'max-w-full sm:max-w-40')}
        >
          <option value="">{loading ? 'Loading models…' : models.length === 0 ? 'Default model' : 'Auto model'}</option>
          {models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.label}{tierNote(m.tier)}</option>)}
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground"><ChevronDownIcon size={11} /></div>
      </div>
      {efforts.length > 0 ? (
        <div className={cn('relative min-w-0 max-w-full', variant === 'box' && 'basis-28 flex-1')}>
          <label htmlFor={effortId} className="sr-only">{label ? `${label} effort` : 'Effort'}</label>
          <select
            id={effortId}
            value={value.effort ?? ''}
            title="Reasoning effort. Higher effort thinks longer and uses more tokens."
            onChange={(e) => { set({ effort: e.target.value || undefined }); }}
            className={cn(cls, variant === 'pill' && 'max-w-full sm:max-w-32')}
          >
            <option value="">Auto effort</option>
            {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABELS[e] ?? e} effort</option>)}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground"><ChevronDownIcon size={11} /></div>
        </div>
      ) : null}
    </div>
  );
}
