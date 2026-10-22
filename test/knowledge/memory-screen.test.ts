import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
const screenPath = '../../src/renderer/screens/MemoryScreen.tsx';

it('offers memory search and creation with context navigation', async () => {
  const { MemoryScreen } = await import(screenPath);
  const page = renderToStaticMarkup(createElement(MemoryScreen));
  expect(page).toContain('Add memory');
  expect(page).toContain('Search');
  expect(page).toContain('Context');
  expect(page).toContain('Loading memories');
});
