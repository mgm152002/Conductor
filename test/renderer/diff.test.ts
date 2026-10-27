import { describe, expect, it } from 'vitest';
import { diffLineKind } from '../../src/renderer/lib/diff';

describe('diff line classification', () => {
  it('separates additions, deletions, hunks, headers and context', () => {
    expect(diffLineKind('diff --git a/a.ts b/a.ts')).toBe('header');
    expect(diffLineKind('--- a/a.ts')).toBe('header');
    expect(diffLineKind('+++ b/a.ts')).toBe('header');
    expect(diffLineKind('@@ -1,2 +1,3 @@')).toBe('hunk');
    expect(diffLineKind('+added')).toBe('add');
    expect(diffLineKind('-removed')).toBe('delete');
    expect(diffLineKind(' unchanged')).toBe('context');
    expect(diffLineKind('\\ No newline at end of file')).toBe('context');
  });

  it('does not mistake a file header for an addition or deletion', () => {
    expect(diffLineKind('+++ b/file.ts')).not.toBe('add');
    expect(diffLineKind('--- a/file.ts')).not.toBe('delete');
  });
});
