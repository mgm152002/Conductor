import { describe, expect, it } from 'vitest';
import { buildVisualSrcDoc, normalizeSvgForImage, sanitizeVisualHtml, splitVideoUrls, splitVisualBlocks, visualAspectRatio } from '../../src/renderer/lib/visuals';

describe('splitVisualBlocks', () => {
  it('keeps plain markdown as one segment', () => {
    expect(splitVisualBlocks('hello **world**')).toEqual([{ type: 'markdown', text: 'hello **world**' }]);
  });

  it('extracts a closed html block between prose', () => {
    const segments = splitVisualBlocks('Before\n\n```html\n<svg></svg>\n```\n\nAfter');
    expect(segments.map((s) => s.type)).toEqual(['markdown', 'html', 'markdown']);
    const html = segments[1] as Extract<typeof segments[number], { type: 'html' }>;
    expect(html.complete).toBe(true);
    expect(html.code).toContain('<svg>');
  });

  it('marks an unclosed fence as still assembling', () => {
    const segments = splitVisualBlocks('```html\n<svg><rect');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'html', complete: false });
  });

  it('extracts a mermaid block between prose', () => {
    const segments = splitVisualBlocks('Before\n\n```mermaid\nflowchart TD\n  A-->B\n```\n\nAfter');
    expect(segments.map((s) => s.type)).toEqual(['markdown', 'mermaid', 'markdown']);
    const diagram = segments[1] as Extract<typeof segments[number], { type: 'mermaid' }>;
    expect(diagram.complete).toBe(true);
    expect(diagram.code).toContain('flowchart TD');
  });

  it('marks an unclosed mermaid fence as still assembling', () => {
    const segments = splitVisualBlocks('```mermaid\nflowchart TD\n  A--');
    expect(segments).toEqual([{ type: 'mermaid', code: 'flowchart TD\n  A--', complete: false }]);
  });

  it('does not treat other code fences as visuals', () => {
    const segments = splitVisualBlocks('```ts\nconst x = 1;\n```');
    expect(segments).toEqual([{ type: 'markdown', text: '```ts\nconst x = 1;\n```' }]);
  });
});

describe('sanitizeVisualHtml', () => {
  it('strips scripts, handlers, and external references', () => {
    const dirty = '<div onclick="steal()"><script>alert(1)</script><img src="https://evil.example/x.png"><a href="javascript:alert(1)">x</a><svg><rect style="fill:url(https://evil.example)"/></svg></div>';
    const clean = sanitizeVisualHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('<svg>');
  });
});

describe('normalizeSvgForImage', () => {
  it('repairs bare ampersands, adds a namespace, and sizes from the viewBox', () => {
    const svg = normalizeSvgForImage('<div>wrap</div><svg viewBox="0 0 800 400"><text>Fish & Chips</text></svg>');
    expect(svg).not.toBeNull();
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="400"');
    expect(svg).toContain('Fish &amp; Chips');
    expect(svg).not.toContain('<div>');
  });

  it('converts HTML named entities and stray "<" that are invalid in XML', () => {
    const svg = normalizeSvgForImage('<svg viewBox="0 0 100 50"><text>a&nbsp;b &copy; x < y</text><br></svg>');
    expect(svg).toContain('a&#160;b');
    expect(svg).toContain('&#169;');
    expect(svg).toContain('x &lt; y');
    expect(svg).not.toContain('&nbsp;');
  });

  it('keeps valid entities and returns null without an SVG', () => {
    expect(normalizeSvgForImage('<svg width="10" height="10"><text>a &amp; b</text></svg>')).toContain('a &amp; b');
    expect(normalizeSvgForImage('<p>no diagram</p>')).toBeNull();
  });
});

describe('splitVideoUrls', () => {
  it('turns direct video file URLs into player segments', () => {
    expect(splitVideoUrls('Done: https://cdn.example.com/clip.mp4?sig=1 enjoy')).toEqual([
      { type: 'text', text: 'Done: ' },
      { type: 'video', url: 'https://cdn.example.com/clip.mp4?sig=1' },
      { type: 'text', text: ' enjoy' },
    ]);
    expect(splitVideoUrls('no video here')).toEqual([{ type: 'text', text: 'no video here' }]);
  });
});

describe('buildVisualSrcDoc / visualAspectRatio', () => {
  it('wraps the fragment with assembly styles and theme colour', () => {
    const doc = buildVisualSrcDoc('<svg viewBox="0 0 100 50"></svg>', true);
    expect(doc).toContain('cv-in');
    expect(doc).toContain('#e6ede3');
    expect(doc).toContain('<svg');
  });

  it('reads the aspect ratio from the first viewBox', () => {
    expect(visualAspectRatio('<svg viewBox="0 0 200 100"></svg>')).toBe(2);
    expect(visualAspectRatio('<div>no svg</div>')).toBeNull();
  });
});
