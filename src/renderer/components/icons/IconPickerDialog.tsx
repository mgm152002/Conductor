import { useState } from 'react';
import type { IconTargetKind } from '@shared/icon-contract';
import { MAX_ICON_DATA_URL_LENGTH, isValidIconDataUrl } from '@shared/icon-contract';
import { useChatStore } from '../../stores/chat-store';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { Alert, Button, Dialog } from '../ui/primitives';
import { EntityIcon } from '../ui/EntityIcon';
import { IconChooser, choiceSvg, svgDataUrl, type IconChoice } from './IconChooser';

// Choose the icon for a Space or a project: an icon, an emoji, one or two
// letters, or your own image. Nothing is stored until Save.

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('Choose an image file (PNG, JPEG, WebP, GIF or SVG).')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      if (value.length > MAX_ICON_DATA_URL_LENGTH) { reject(new Error('That image is too large — choose one under 256 KiB.')); return; }
      if (!isValidIconDataUrl(value)) { reject(new Error('That file could not be used as an icon. For SVG, scripts are not allowed.')); return; }
      resolve(value);
    };
    reader.onerror = () => { reject(new Error('Could not read that file.')); };
    reader.readAsDataURL(file);
  });
}

export const choiceDataUrl = (choice: IconChoice): string => (choice.kind === 'image' ? choice.dataUrl : svgDataUrl(choiceSvg(choice)));

export function IconPickerDialog({ target, open, onClose }: {
  target: { kind: IconTargetKind; id: string; name: string; icon?: string | null };
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<string | null>(target.icon ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = target.kind === 'space' ? 'space' : 'project';

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

  return (
    <Dialog
      open={open}
      onClose={() => { if (!saving) onClose(); }}
      title={`Choose ${label} icon`}
      description="Choose an icon, emoji, monogram or image."
      width="max-w-lg"
      footer={(
        <>
          {target.icon ? <Button variant="ghost" className="mr-auto" disabled={saving} onClick={() => { void save(null); }}>Reset</Button> : null}
          <Button variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving || preview === null || preview === (target.icon ?? null)} onClick={() => { void save(preview); }}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5">
          {preview !== null
            ? <img src={preview} alt="" className="size-9 shrink-0 rounded-lg object-cover" />
            : <EntityIcon icon={null} name={target.name} kind={target.kind} size={36} />}
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{target.name}</span>
        </div>
        <IconChooser name={target.name} onChange={(choice) => { setError(null); setPreview(choiceDataUrl(choice)); }} onImage={readImage} />
        {error !== null ? <Alert>{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
