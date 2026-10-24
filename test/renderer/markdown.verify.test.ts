import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Markdown } from '../../src/renderer/components/chat/Markdown';

const source = `# Heading one

## Heading two

A paragraph with **bold**, *italic*, ~~strike~~ and \`inline code\`.

> A quote

- item one
  - nested item
1. ordered
2. second

- [x] done
- [ ] open

| Name | Value |
| --- | ---: |
| Alpha | 1 |
| Beta | 2 |

[link](https://example.com)

\`\`\`ts
const x = 1;
\`\`\`
`;

it('renders GFM structures', () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: source }));
  console.log(html);
  expect(html).toContain('<h1');
  expect(html).toContain('<h2');
  expect(html).toContain('<strong');
  expect(html).toContain('<em');
  expect(html).toContain('<del');
  expect(html).toContain('<blockquote');
  expect(html).toContain('<ul');
  expect(html).toContain('<ol');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('<table');
  expect(html).toContain('<th');
  expect(html).toContain('<td');
  expect(html).toContain('overflow-x-auto');
  expect(html).toContain('<pre');
  expect(html).toContain('language-ts');
  expect(html).not.toContain('<a ');
});

it('does not render raw HTML', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { text: '<script>alert(1)</script><b>bold</b>\n\nHi <img src="x" onerror="alert(1)">' }),
  );
  console.log('HTML:', html);
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<b>');
  expect(html).not.toContain('onerror');
});

it('renders partial streaming text without crashing', () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: '## Stream\n\n- one\n- two' }));
  expect(html).toContain('Stream');
  expect(html).toContain('<li');
});
