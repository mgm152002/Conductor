import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { attachmentBatchError, attachmentSizeError, type AttachmentIngestResult, type AttachmentSummary } from '@shared/attachments';

export interface AttachmentDraftError { fileName: string; message: string }
export interface AttachmentProgress { completed: number; total: number; fileName: string }

/** Shared task/chat draft. Call reset() only after a successful send (it keeps stored files). */
export function useAttachmentDraft() {
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const current = useRef<AttachmentSummary[]>([]);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AttachmentProgress | null>(null);
  const [errors, setErrors] = useState<AttachmentDraftError[]>([]);
  const report = useCallback((fileName: string, message: string) => {
    setErrors(previous => [...previous, { fileName, message }]);
  }, []);
  const update = (next: AttachmentSummary[]) => { current.current = next; setAttachments(next); };
  const accept = async (result: AttachmentIngestResult) => {
    setErrors(previous => [...previous, ...result.rejected]);
    for (const attachment of result.attachments) {
      if (current.current.some(item => item.id === attachment.id)) continue;
      const error = attachmentSizeError(attachment.sizeBytes) ?? attachmentBatchError(current.current.length + 1,
        current.current.reduce((sum, item) => sum + item.sizeBytes, 0) + attachment.sizeBytes);
      if (error) {
        report(attachment.name, error);
        try { await window.conductor.attachment.discard(attachment.id); }
        catch { report(attachment.name, 'Could not clean up the rejected attachment.'); }
      } else update([...current.current, attachment]);
    }
  };
  const run = async (operation: () => Promise<void>) => {
    if (locked.current) { report('Selection', 'Wait for the current attachment operation to finish.'); return; }
    locked.current = true; setBusy(true);
    try { await operation(); }
    catch { report('Selection', 'Could not attach files. Please try again.'); }
    finally { locked.current = false; setBusy(false); setProgress(null); }
  };
  const pick = () => run(async () => {
    const error = attachmentBatchError(current.current.length + 1);
    if (error) { report('Selection', error); return; }
    // Native pick combines selection and ingestion; main validates size before reading.
    setProgress({ completed: 0, total: 0, fileName: 'Choosing and attaching files…' });
    await accept(await window.conductor.attachment.pick());
  });
  const addFiles = (files: Iterable<File>) => {
    const selection = Array.from(files);
    return run(async () => {
      const batchError = attachmentBatchError(current.current.length + selection.length,
        current.current.reduce((sum, item) => sum + item.sizeBytes, 0) + selection.reduce((sum, file) => sum + file.size, 0));
      if (batchError) { selection.forEach(file => report(file.name, batchError)); return; }
      for (const [index, file] of selection.entries()) {
        setProgress({ completed: index, total: selection.length, fileName: file.name });
        const sizeError = attachmentSizeError(file.size);
        if (sizeError) { report(file.name, sizeError); continue; }
        // Older Electron File objects expose path. Sandboxed runtimes without it
        // need a preload File/clipboard bridge; never invent a path from file.name.
        const path = (file as File & { path?: string }).path;
        if (!path) { report(file.name, 'This app cannot read this dropped or pasted file. Save it and use Attach files.'); continue; }
        try { await accept(await window.conductor.attachment.ingest({ paths: [path] })); }
        catch { report(file.name, 'Could not attach this file. Try selecting it again.'); }
      }
    });
  };
  const remove = (id: string) => run(async () => {
    const item = current.current.find(attachment => attachment.id === id);
    if (!item) return;
    try { await window.conductor.attachment.discard(id); update(current.current.filter(attachment => attachment.id !== id)); }
    catch { report(item.name, 'Could not remove this attachment. Please try again.'); }
  });
  const reset = () => { if (!locked.current) { update([]); setErrors([]); } };
  const clear = () => run(async () => {
    for (const item of [...current.current]) {
      try { await window.conductor.attachment.discard(item.id); update(current.current.filter(attachment => attachment.id !== item.id)); }
      catch { report(item.name, 'Could not remove this attachment. Please try again.'); }
    }
  });
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); void addFiles(event.dataTransfer.files);
  };
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (!images.length) return;
    // Preserve any text accompanying an image paste.
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    void addFiles(images);
  };
  return { attachments, attachmentIds: attachments.map(item => item.id), busy, progress, errors,
    pick, addFiles, remove, reset, clear, clearErrors: () => setErrors([]), onDragOver, onDrop, onPaste };
}

export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;
