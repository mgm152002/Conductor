import { useEffect, useRef, useState } from 'react';
import type { IconTargetKind } from '@shared/icon-contract';
import { MAX_ICON_DATA_URL_LENGTH, isValidIconDataUrl } from '@shared/icon-contract';
import type { RunChoice } from '@shared/agent-models';
import { useChatStore } from '../../stores/chat-store';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { Alert, Button, Dialog, inputClassName } from '../ui/primitives';
import { MenuSelect } from '../ui/MenuSelect';
import { ModelEffortPicker } from '../chat/ModelEffortPicker';
import { EntityIcon } from '../ui/EntityIcon';
import { ImageIcon, SparklesIcon } from '../ui/icons';
import { cn } from '../../lib/cn';

// Choose a custom icon for a Space or a project: generate one with a model,
// or upload an image. Generation only previews — nothing is stored until Save.

type Mode = 'model' | 'upload';

export function IconPickerDialog({ target, open, onClose }: {
  target: { kind: IconTargetKind; id: string; name: string; icon?: string | null };
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let active = true;
    void window.conductor.registry.listAdapters()
      .then((list) => { if (active) setAgents(list.filter((a) => a.available && a.class === 'local_cli_agent').map((a) => ({ id: a.id, name: a.name }))); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  const [mode, setMode] = useState<Mode>('model');
  const [agentId, setAgentId] = useState('');
  const [run, setRun] = useState<RunChoice>({});
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<string | null>(target.icon ?? null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedAgent = agents.find((a) => a.id === agentId) ?? agents[0];
  const label = target.kind === 'space' ? 'space' : 'project';

  async function generate(): Promise<void> {
    if (busy || selectedAgent === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const icon = await window.conductor.icon.generate({
        targetKind: target.kind,
        name: target.name,
        ...(prompt.trim() !== '' ? { prompt: prompt.trim() } : {}),
        mode: 'model',
        agentId: selectedAgent.id,
        ...(run.model !== undefined ? { model: run.model } : {}),
      });
      setPreview(icon);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate an icon');
    } finally {
      setBusy(false);
    }
  }

  function onFile(file: File | undefined): void {
    if (file === undefined) return;
    setError(null);
    if (!file.type.startsWith('image/')) { setError('Choose an image file (PNG, JPEG, WebP, GIF or SVG).'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      if (value.length > MAX_ICON_DATA_URL_LENGTH) { setError('That image is too large — choose one under 256 KiB.'); return; }
      if (!isValidIconDataUrl(value)) { setError('That file could not be used as an icon. For SVG, scripts are not allowed.'); return; }
      setPreview(value);
    };
    reader.onerror = () => { setError('Could not read that file.'); };
    reader.readAsDataURL(file);
  }

  async function save(icon: string | null): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (target.kind === 'space') {
        const saved = await window.conductor.chat.setSpaceIcon(target.id, icon);
        useChatStore.getState().upsertSpace(saved);
      } else {
        const saved = await window.conductor.workspace.setIcon(target.id, icon);
        useWorkspaceStore.getState().upsert(saved);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the icon');
    } finally {
      setSaving(false);
    }
  }

  const modes: { id: Mode; label: string; icon: React.JSX.Element; hint: string }[] = [
    { id: 'model', label: 'Model', icon: <SparklesIcon size={13} />, hint: 'The model you pick draws the icon as SVG.' },
    { id: 'upload', label: 'Upload', icon: <ImageIcon size={13} />, hint: 'Use your own image file.' },
  ];

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy && !saving) onClose(); }}
      title={`Icon for “${target.name}”`}
      description={`Generate an icon with a model, or upload your own. It appears next to the ${label} in the sidebar.`}
      footer={(
        <>
          {target.icon ? <Button variant="ghost" disabled={saving || busy} onClick={() => { void save(null); }}>Remove icon</Button> : null}
          <Button variant="ghost" disabled={saving || busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving || busy || preview === null || preview === (target.icon ?? null)} onClick={() => { void save(preview); }}>
            {saving ? 'Saving…' : 'Save icon'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-14 items-center justify-center rounded-lg bg-accent">
            {preview !== null
              ? <img src={preview} alt="" className="size-12 rounded-md object-cover" />
              : <EntityIcon icon={null} name={target.name} kind={target.kind} size={48} />}
          </div>
          <div role="radiogroup" aria-label="Icon source" className="flex flex-1 gap-1">
            {modes.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={mode === item.id}
                onClick={() => { setMode(item.id); setError(null); }}
                className={cn('flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring', mode === item.id ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}
              >
                {item.icon}{item.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{modes.find((m) => m.id === mode)?.hint}</p>

        {mode === 'upload' ? (
          <div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" className="hidden" aria-label="Upload icon image" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ''; }} />
            <Button variant="outline" onClick={() => { fileRef.current?.click(); }}>Choose image…</Button>
            <span className="ml-2 text-2xs text-muted-foreground">PNG, JPEG, WebP, GIF or SVG, under 256 KiB.</span>
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Agent</span>
              {agents.length === 0
                ? <span className="text-xs text-muted-foreground">No agent is available. Install/enable one, or upload an icon instead.</span>
                : (
                  <MenuSelect
                    variant="box"
                    label="Agent for icon generation"
                    value={selectedAgent?.id ?? ''}
                    onChange={(next) => { setAgentId(next); setRun({}); }}
                    options={agents.map((a) => ({ value: a.id, label: a.name }))}
                  />
                )}
            </label>
            {selectedAgent !== undefined ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Model</span>
                <ModelEffortPicker agentId={selectedAgent.id} value={run} onChange={setRun} variant="box" label="Icon" />
              </div>
            ) : null}
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Describe the icon (optional)</span>
              <input value={prompt} onChange={(event) => { setPrompt(event.target.value); }} maxLength={500} placeholder="e.g. a paper plane over waves, teal and coral" className={inputClassName} aria-label="Icon description" />
            </label>
            <Button variant="outline" disabled={busy || selectedAgent === undefined} onClick={() => { void generate(); }} className="self-start">
              {busy ? 'Generating…' : preview !== null && target.icon !== preview ? 'Regenerate' : 'Generate icon'}
            </Button>
          </>
        )}
        {error !== null ? <Alert>{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
