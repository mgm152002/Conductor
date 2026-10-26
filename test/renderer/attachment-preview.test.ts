import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PdfPreview, boundedPdfPage, boundedPdfZoom } from '../../src/renderer/components/attachments/AttachmentPreviewDialog';
import { imageThumbnailSrc } from '../../src/renderer/components/attachments/AttachmentCard';

const preview = {
  format: 'pdf' as const,
  attachment: { id: 'attachment-1', name: 'report.pdf', kind: 'pdf' as const, mimeType: 'application/pdf', sizeBytes: 12 },
  pageCount: 2,
  truncated: false,
  pages: [
    { pageNumber: 1, text: 'First page text', dataUrl: 'data:image/png;base64,AAAA' },
    { pageNumber: 2, text: 'Second page text', dataUrl: 'data:image/png;base64,BBBB' },
  ],
};

describe('attachment preview', () => {
  it('renders the native PDF page with accessible navigation, zoom, and text view controls', () => {
    const html = renderToStaticMarkup(createElement(PdfPreview, { preview }));

    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).toContain('alt="Rendered PDF page 1"');
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('Show extracted text');
  });

  it('bounds PDF navigation and zoom values at their safe limits', () => {
    expect(boundedPdfPage(1, 2, -1)).toBe(1);
    expect(boundedPdfPage(1, 2, 1)).toBe(2);
    expect(boundedPdfPage(2, 2, 1)).toBe(2);
    expect(boundedPdfZoom(0.6, -0.2)).toBe(0.6);
    expect(boundedPdfZoom(2, 0.2)).toBe(2);
  });

  it('uses only an image data URL for a pasted-image thumbnail', () => {
    const image = { format: 'image' as const, attachment: preview.attachment, dataUrl: 'data:image/png;base64,AAAA', truncated: false };
    expect(imageThumbnailSrc(image)).toBe('data:image/png;base64,AAAA');
    expect(imageThumbnailSrc({ ...image, dataUrl: 'https://example.invalid/image.png' })).toBeNull();
  });
});
