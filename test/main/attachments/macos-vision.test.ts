import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatPdfWithMacos,
  recognizeImageWithMacos,
  type NativeVisionInvocation,
} from '../../../src/main/attachments/macos-vision';

const png = Buffer.from('89504e470d0a1a0a', 'hex');

describe('macOS native attachment formatting boundary', () => {
  it('returns rendered PDF pages and cleans every temporary file', async () => {
    let directory = '';
    const run = async (invocation: NativeVisionInvocation): Promise<void> => {
      directory = invocation.directory;
      writeFileSync(`${directory}/page-1.png`, png);
      writeFileSync(invocation.manifestPath, JSON.stringify({
        pageCount: 2,
        pages: [
          { pageNumber: 1, text: 'Native page one', imageFile: 'page-1.png' },
          { pageNumber: 2, text: 'Native page two' },
        ],
        truncated: false,
      }));
    };

    const result = await formatPdfWithMacos(Buffer.from('%PDF-1.7'), run);

    expect(result).toEqual({
      pageCount: 2,
      pages: [
        { pageNumber: 1, text: 'Native page one', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
        { pageNumber: 2, text: 'Native page two' },
      ],
      truncated: false,
    });
    expect(existsSync(directory)).toBe(false);
  });

  it('redacts and caps native OCR text before returning it', async () => {
    const run = async (invocation: NativeVisionInvocation): Promise<void> => {
      writeFileSync(invocation.manifestPath, JSON.stringify({
        text: `${'x'.repeat(40_000)}\nAPI_KEY=secret-value`,
      }));
    };

    const text = await recognizeImageWithMacos(png, 'image/png', run);

    expect(text).toHaveLength(40_000);
    expect(text).not.toContain('secret-value');
  });

  it('returns null instead of leaking native runner failures', async () => {
    const fail = async (): Promise<void> => { throw Object.assign(new Error('/private/path API_KEY=secret'), { code: 'ETIMEDOUT' }); };

    await expect(formatPdfWithMacos(Buffer.from('%PDF-1.7'), fail)).resolves.toBeNull();
    await expect(recognizeImageWithMacos(png, 'image/png', fail)).resolves.toBeUndefined();
  });
});
