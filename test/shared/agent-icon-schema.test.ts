import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INTEGRATION_SCHEMAS } from '@shared/integrations-contract';

// An agent without a custom icon is stored with icon '' (the default agents
// of a fresh install all are), and the editor sends that back on save.
const agent = { name: 'Researcher', description: '', instructions: '', clis: ['claude-code'], tools: ['browser'], approval: 'risky', color: '#4f46e5' };

describe('agent icon in create/update requests', () => {
  it('accepts an empty icon (no custom icon) on update and create', () => {
    expect(INTEGRATION_SCHEMAS['agents.sandbox.update'].safeParse({ ...agent, id: randomUUID(), icon: '' }).success).toBe(true);
    expect(INTEGRATION_SCHEMAS['agents.sandbox.create'].safeParse({ ...agent, icon: '' }).success).toBe(true);
  });

  it('still accepts a small raster data URL and a missing icon, and rejects anything else', () => {
    const update = INTEGRATION_SCHEMAS['agents.sandbox.update'];
    expect(update.safeParse({ ...agent, id: randomUUID(), icon: 'data:image/png;base64,iVBORw0KGgo=' }).success).toBe(true);
    expect(update.safeParse({ ...agent, id: randomUUID() }).success).toBe(true);
    expect(update.safeParse({ ...agent, id: randomUUID(), icon: 'javascript:alert(1)' }).success).toBe(false);
    expect(update.safeParse({ ...agent, id: randomUUID(), icon: 'data:image/svg+xml;base64,PHN2Zz4=' }).success).toBe(false);
  });
});
