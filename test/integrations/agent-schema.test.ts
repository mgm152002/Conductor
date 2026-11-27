import { describe, expect, it } from 'vitest';
import { INTEGRATION_SCHEMAS } from '../../src/shared/integrations-contract';

const baseAgent = {
  name: 'Resume Tailor',
  description: '',
  instructions: 'Tailor resume for each job',
  clis: ['antigravity'],
  tools: ['files'] as const,
  approval: 'none' as const,
  color: '#c9379a',
};

describe('agents.sandbox schema', () => {
  it('accepts an empty icon string on update and create', () => {
    const id = '8b0b001a-272c-46ab-9d0b-dfd839f6d519';
    expect(INTEGRATION_SCHEMAS['agents.sandbox.create'].safeParse({ ...baseAgent, icon: '' }).success).toBe(true);
    expect(INTEGRATION_SCHEMAS['agents.sandbox.update'].safeParse({ id, ...baseAgent, icon: '' }).success).toBe(true);
    expect(INTEGRATION_SCHEMAS['agents.sandbox.update'].safeParse({ id, ...baseAgent }).success).toBe(true);
  });

  it('accepts valid image data URLs and rejects invalid non-empty icon strings', () => {
    const id = '8b0b001a-272c-46ab-9d0b-dfd839f6d519';
    expect(INTEGRATION_SCHEMAS['agents.sandbox.update'].safeParse({
      id,
      ...baseAgent,
      icon: 'data:image/png;base64,iVBORw0KGgo=',
    }).success).toBe(true);
    expect(INTEGRATION_SCHEMAS['agents.sandbox.update'].safeParse({
      id,
      ...baseAgent,
      icon: 'data:image/svg+xml;base64,PHN2Zz4=',
    }).success).toBe(false);
    expect(INTEGRATION_SCHEMAS['agents.sandbox.update'].safeParse({
      id,
      ...baseAgent,
      icon: 'not-a-data-url',
    }).success).toBe(false);
  });
});
