import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from '../../src/renderer/lib/markdown-blocks';

const whole = (text: string): string => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], skipHtml: true }, text));
const blockwise = (text: string): string => splitMarkdownBlocks(text).map(whole).join('');
// react-markdown puts a newline text node between top-level elements. In the
// message's flex column a whitespace-only node between items renders nothing,
// so it is the one difference the comparison ignores.
const between = (html: string): string => html.replace(/>\n</g, '><');

const SAMPLES: Record<string, string> = {
  prose: '# Title\n\nFirst paragraph with **bold**.\n\nSecond paragraph.\n\n## Next\n\nMore text.',
  looseList: 'Intro\n\n- one\n\n- two\n\n  continued in two\n\n- three\n\nAfter the list.',
  orderedLoose: '1. first\n\n2. second\n\n   indented para\n\n       nested code\n\n3. third',
  nestedList: '- a\n  - b\n\n    still b\n- c\n\nDone.',
  fenceWithBlankLines: 'Before\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter',
  tildeFence: '~~~\n```\n\nnot closed by backticks\n~~~\n\nTail',
  unclosedFence: 'Text\n\n```py\nprint(1)\n\nprint(2)',
  table: 'Table:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter table.',
  quote: '> one\n\n> two\n\nPlain.',
  references: 'See [docs][d].\n\nMore.\n\n[d]: https://example.com',
  thematicBreak: 'Above\n\n---\n\nBelow',
  trailingBlank: 'One\n\nTwo\n\n\n',
  indentedCode: 'Text\n\n    code block\n\n    more code\n\nText again',
};

describe('splitMarkdownBlocks', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    it(`renders ${name} the same block by block as in one pass`, () => {
      expect(between(blockwise(text))).toBe(between(whole(text)));
    });
  }

  it('cuts plain paragraphs apart', () => {
    expect(splitMarkdownBlocks('a\n\nb\n\nc')).toEqual(['a', 'b', 'c']);
  });

  it('keeps fenced code with blank lines in one block', () => {
    expect(splitMarkdownBlocks('```\nx\n\ny\n```\n\nz')).toEqual(['```\nx\n\ny\n```', 'z']);
  });

  it('leaves text with reference definitions whole', () => {
    expect(splitMarkdownBlocks(SAMPLES['references']!)).toHaveLength(1);
  });

  it('only the last block changes as a reply streams in', () => {
    const early = splitMarkdownBlocks('Para one.\n\nPara two is gro');
    const later = splitMarkdownBlocks('Para one.\n\nPara two is growing.');
    expect(later[0]).toBe(early[0]);
  });
});
