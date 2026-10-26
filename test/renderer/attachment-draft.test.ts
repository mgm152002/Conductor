import { File } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { attachmentInputForFile, pastedImageFiles } from '../../src/renderer/components/attachments/useAttachmentDraft';

describe('attachment draft clipboard handling', () => {
  it('reads bytes for a pasted image that has no Electron filesystem path', async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'clipboard.png', { type: 'image/png' });

    await expect(attachmentInputForFile(file)).resolves.toEqual({
      kind: 'bytes',
      input: { name: 'clipboard.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    });
  });

  it('keeps accompanying clipboard text and prevents an image-only paste', () => {
    const image = new File(['image'], 'paste.png', { type: 'image/png' });
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });

    expect(pastedImageFiles({ files: [image, text], text: 'caption' })).toEqual({ files: [image], preventDefault: false });
    expect(pastedImageFiles({ files: [image], text: '' })).toEqual({ files: [image], preventDefault: true });
  });
});
