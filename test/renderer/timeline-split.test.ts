import { describe, expect, it } from 'vitest';
import { safeSplitOffset } from '../../src/renderer/lib/timeline';

describe('safeSplitOffset', () => {
  const text = 'I would give this 20/20, based on the [implementation](https://github.com/mgm152002/replica) and README.';
  it('never cuts inside a link', () => {
    const mid = text.indexOf('github') + 3;
    const split = safeSplitOffset(text, 0, mid);
    expect(text.slice(0, split)).not.toContain('[implementation]');
    expect(text.slice(0, split).endsWith(' ')).toBe(true);
  });
  it('splits at the start of the line when mid-line', () => {
    const t = 'first line\nsecond li';
    expect(safeSplitOffset(t, 0, t.length - 1)).toBe('first line\n'.length);
  });
  it('keeps a split that is already on a boundary', () => {
    const t = 'one\n\ntwo three';
    expect(safeSplitOffset(t, 0, 5)).toBe(5);
  });
  it('moves out of an open code fence', () => {
    const t = 'intro\n```ts\nconst a = 1;\nconst b';
    const split = safeSplitOffset(t, 0, t.length - 2);
    expect(t.slice(0, split)).toBe('intro\n');
  });
});
