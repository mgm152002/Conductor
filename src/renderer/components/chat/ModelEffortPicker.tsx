import type { RunChoice } from '@shared/agent-models';
import { useAgentModels } from '../../hooks/useAgentModels';
import { cn } from '../../lib/cn';
import { SparklesIcon } from '../ui/icons';
import { ProviderAvatar, modelBrand } from '../ui/BrandMarks';
import { MenuSelect } from '../ui/MenuSelect';

// Model and reasoning-effort pickers for one agent. "Auto" lets Conductor pick
// by how demanding the work is (a cheaper model and lower effort for quick
// requests). The lists come from the agent CLI itself. Models carry their
// provider's logo (see BrandMarks); efforts are plain text.

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
  const models = catalog?.models ?? [];
  const selected = models.find((m) => m.id === value.model);
  // Effort levels the selected model accepts, mirroring run resolution:
  // support is per model (a model carries its own list iff the CLI accepts
  // `--effort` for it). Agent-level efforts are offered only on Auto, when no
  // model is pinned; a specific model is never assumed to inherit them.
  const efforts = value.model === undefined ? catalog?.efforts ?? [] : selected?.efforts ?? [];
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
  const tierNote = (tier: string): string | undefined => (tier === 'economy' ? 'Cheaper' : tier === 'premium' ? 'Most capable' : undefined);

  return (
    <div className={cn('flex min-w-0 max-w-full flex-wrap items-center', variant === 'pill' ? 'gap-0' : 'flex-1 gap-1.5')}>
      <div className={cn('min-w-0 max-w-full', variant === 'box' && 'basis-36 flex-1')}>
        <MenuSelect
          variant={variant}
          searchable
          label={label ? `${label} model` : 'Model'}
          value={value.model ?? ''}
          disabled={loading || models.length === 0}
          title={catalog?.error ?? (models.length === 0 && !loading ? 'This agent uses its own default model' : 'Auto picks a cheaper model for quick requests')}
          onChange={(next) => { set({ model: next || undefined }); }}
          className={variant === 'pill' ? 'max-w-full sm:max-w-44' : undefined}
          options={[
            {
              value: '',
              label: loading ? 'Loading models…' : models.length === 0 ? 'Default model' : 'Auto model',
              mark: <SparklesIcon size={13} />,
            },
            ...models.map((m) => ({
              value: m.id,
              label: m.label,
              ...(tierNote(m.tier) !== undefined ? { hint: tierNote(m.tier)! } : {}),
              mark: <ProviderAvatar brand={modelBrand(m.id)} label={m.label} size={13} />,
            })),
          ]}
        />
      </div>
      {efforts.length > 0 ? (
        <div className={cn('min-w-0 max-w-full', variant === 'box' && 'basis-28 flex-1')}>
          <MenuSelect
            variant={variant}
            label={label ? `${label} effort` : 'Effort'}
            value={value.effort ?? ''}
            title="Higher effort thinks longer"
            onChange={(next) => { set({ effort: next || undefined }); }}
            className={variant === 'pill' ? 'max-w-full sm:max-w-32' : undefined}
            options={[
              { value: '', label: 'Auto effort' },
              ...efforts.map((e) => ({ value: e, label: `${EFFORT_LABELS[e] ?? e} effort` })),
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
