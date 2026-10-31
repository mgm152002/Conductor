import { describe, expect, it } from 'vitest';
import { buildVisualSrcDoc, sanitizeVisualHtml, splitVisualBlocks, visualAspectRatio } from '../../src/renderer/lib/visuals';

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
