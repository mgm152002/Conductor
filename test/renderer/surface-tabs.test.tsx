import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SurfaceTabs } from '../../src/renderer/components/SurfaceTabs';
import { useChatStore } from '../../src/renderer/stores/chat-store';

// Switching between the Chat and Work surfaces must land on a fresh
// composition on the side you switch to (a new chat / a new thread draft),
// so the tabs are actions with that behavior, not plain links that restore
// whichever conversation was open before.
describe('SurfaceTabs', () => {
  it('renders Work and Chat as switch actions with the current surface marked', () => {
    useChatStore.setState({ selectedId: 'old-chat' });
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(SurfaceTabs)));
    expect(html).toContain('aria-label="Workspace views"');
    expect(html).toContain('>Work</button>');
    expect(html).toContain('>Chat</button>');
    expect(html).toContain('aria-current="page"');
    // Actions, not links: no href restores the previously open conversation.
    expect(html).not.toContain('href=');
    useChatStore.setState({ selectedId: null });
  });
});
