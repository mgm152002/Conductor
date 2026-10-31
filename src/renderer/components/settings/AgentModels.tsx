import { useEffect, useId, useState } from 'react';
import type { RunChoice } from '@shared/agent-models';
import { isValidModelId } from '@shared/model-defaults';
import { useAgents } from '../../hooks/useAgents';
import { loadAgentModels, useAgentModels } from '../../hooks/useAgentModels';
import { ModelEffortPicker } from '../chat/ModelEffortPicker';
import { Button, inputClassName } from '../ui/primitives';
import { BrandMark, agentBrand, modelBrand } from '../ui/BrandMarks';

// Default model and reasoning effort per agent. "Auto" lets Conductor choose
// by how demanding each request is: quick questions run on the agent's
// cheaper model at low effort, large builds on its most capable model. A
// choice in the composer overrides these for one message.
// The fallback model is used when the default/model hits a quota or model limit
// before switching to another CLI.

const MODEL = /^[\w./:@-]{1,100}$/;

type AgentModelValues = {
  default: RunChoice;
  fallback?: RunChoice;
};

function AgentRow({
  id,
  name,
  values,
  onDefaultChange,
  onFallbackChange,
}: {
  id: string;
  name: string;
  values: AgentModelValues;
  onDefaultChange: (v: RunChoice) => void;
  onFallbackChange: (v: RunChoice | undefined) => void;
}): React.JSX.Element {
  const catalog = useAgentModels(id);
  const inputId = useId();
  const listed = catalog !== null && catalog.models.length > 0;
  const fallbackValue = values.fallback ?? {};

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
      <div className="flex items-center gap-2">
        <span className="flex w-32 shrink-0 items-center gap-1.5 text-xs font-medium text-foreground">
          <BrandMark brand={agentBrand(id)} size={13} className="shrink-0 text-foreground/80" />
          <span className="truncate">{name}</span>
        </span>
        <span className="text-2xs text-muted-foreground">Default</span>
      </div>
      <div className="flex items-center gap-2 pl-32">
        {catalog === null || listed ? (
          <ModelEffortPicker variant="box" agentId={id} label={`${name} default`} value={values.default} onChange={onDefaultChange} />
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <BrandMark brand={modelBrand(values.default.model)} size={14} className="shrink-0 text-foreground/80" />
            <label htmlFor={inputId} className="sr-only">{name} model</label>
            <input
              id={inputId}
              className={`${inputClassName} h-7 font-mono text-xs`}
              placeholder="Agent default (type a model to pin one)"
              value={values.default.model ?? ''}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                const model = e.target.value.trim();
                onDefaultChange(model ? { ...values.default, model } : (({ model: _m, ...rest }) => rest)(values.default));
              }}
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="w-32 shrink-0 text-xs font-medium text-foreground" />
        <span className="text-2xs text-muted-foreground">Fallback model</span>
      </div>
      <div className="flex items-center gap-2 pl-32">
        {catalog === null || listed ? (
          <ModelEffortPicker
            variant="box"
            agentId={id}
            label={`${name} fallback`}
            value={fallbackValue}
            onChange={(choice) => {
              if (choice.model === undefined && choice.effort === undefined) {
                onFallbackChange(undefined);
              } else {
                onFallbackChange(choice);
              }
            }}
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <BrandMark brand={modelBrand(fallbackValue.model)} size={14} className="shrink-0 text-foreground/80" />
            <label htmlFor={`${inputId}-fallback`} className="sr-only">{name} fallback model</label>
            <input
              id={`${inputId}-fallback`}
              className={`${inputClassName} h-7 font-mono text-xs`}
              placeholder="Fallback model (leave empty to clear)"
              value={fallbackValue.model ?? ''}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                const model = e.target.value.trim();
                if (model === '') {
                  onFallbackChange(undefined);
                } else {
                  onFallbackChange({ ...(fallbackValue.effort !== undefined ? { effort: fallbackValue.effort } : {}), model });
                }
              }}
            />
          </div>
        )}
      </div>
      {catalog?.error ? <p className="pl-34 text-3xs text-muted-foreground">{catalog.error}</p> : null}
    </div>
  );
}

export function AgentModels(): React.JSX.Element {
  const agents = useAgents();
  const [values, setValues] = useState<Record<string, AgentModelValues>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = agents.map((a) => a.id).join(',');

  useEffect(() => {
    void Promise.all(
      agents.map(async (agent) => {
        const [model, effort, fallbackModel] = await Promise.all([
          window.conductor.settings.get(`agents.${agent.id}.model`),
          window.conductor.settings.get(`agents.${agent.id}.effort`),
          window.conductor.settings.get(`agents.${agent.id}.fallbackModel`),
        ]);
        const def: RunChoice = {};
        if (typeof model === 'string' && model !== '') def.model = model;
        if (typeof effort === 'string' && effort !== '') def.effort = effort;
        const fallback: RunChoice | undefined = typeof fallbackModel === 'string' && fallbackModel !== '' ? { model: fallbackModel } : undefined;
        const entry: AgentModelValues = { default: def, ...(fallback !== undefined ? { fallback } : {}) };
        return [agent.id, entry] as const;
      }),
    )
      .then((entries) => {
        setValues(Object.fromEntries(entries));
      })
      .catch(() => {});
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(): Promise<void> {
    setError(null);
    setSaved(null);
    try {
      for (const agent of agents) {
        const entry = values[agent.id] ?? { default: {} };
        const def = entry.default ?? {};
        if (def.model !== undefined && def.model !== '' && !(isValidModelId(def.model) || MODEL.test(def.model))) {
          throw new Error(`${agent.name}: model names use letters, numbers, dots, dashes, slashes and colons`);
        }
        const fb = entry.fallback;
        if (fb?.model !== undefined && fb.model !== '' && !(isValidModelId(fb.model) || MODEL.test(fb.model))) {
          throw new Error(`${agent.name}: fallback model names use letters, numbers, dots, dashes, slashes and colons`);
        }
        await window.conductor.settings.set({ key: `agents.${agent.id}.model`, value: def.model ?? '', scope: 'global' });
        await window.conductor.settings.set({ key: `agents.${agent.id}.effort`, value: def.effort ?? '', scope: 'global' });
        if (fb?.model !== undefined && fb.model !== '') {
          await window.conductor.settings.set({ key: `agents.${agent.id}.fallbackModel`, value: fb.model, scope: 'global' });
        } else {
          await window.conductor.settings.set({ key: `agents.${agent.id}.fallbackModel`, value: '', scope: 'global' });
        }
      }
      setSaved('Saved. New messages use these defaults.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section aria-label="Agent models" className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">Default and fallback models</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Fallback runs once if the default hits a limit. The composer can override per message.
          </p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void Promise.all(agents.map((a) => loadAgentModels(a.id, true))).then(() => {
              setValues((v) => ({ ...v }));
            });
          }}
        >
          Refresh lists
        </Button>
      </div>
      {agents.length === 0 ? (
        <p className="text-xs text-muted-foreground">No agent CLIs are connected yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              id={agent.id}
              name={agent.name}
              values={values[agent.id] ?? { default: {} }}
              onDefaultChange={(choice) => {
                setValues((all) => ({ ...all, [agent.id]: { ...(all[agent.id] ?? { default: {} }), default: choice } }));
              }}
              onFallbackChange={(choice) => {
                setValues((all) => {
                  const current = all[agent.id] ?? { default: {} };
                  if (choice === undefined) {
                    const { fallback: _fb, ...rest } = current as AgentModelValues & { fallback?: RunChoice };
                    return { ...all, [agent.id]: rest as AgentModelValues };
                  }
                  return { ...all, [agent.id]: { ...current, fallback: choice } };
                });
              }}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => { void save(); }}>
          Save defaults
        </Button>
        {saved !== null ? (
          <span role="status" className="text-2xs text-success">
            {saved}
          </span>
        ) : null}
        {error !== null ? (
          <span role="alert" className="text-2xs text-destructive-foreground">
            {error}
          </span>
        ) : null}
      </div>
    </section>
  );
}
