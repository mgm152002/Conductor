import { describe, expect, it } from 'vitest';
import { activeToken, matchScore, rankMentions, referenceFileName, replaceToken } from '../../src/renderer/lib/mentions';

describe('composer mentions', () => {
  it('finds an @ token after whitespace or at the start, and / only at a line start', () => {
    expect(activeToken('@src', 4)).toEqual({ trigger: '@', query: 'src', start: 0, end: 4 });
    expect(activeToken('look at @comp', 13)).toEqual({ trigger: '@', query: 'comp', start: 8, end: 13 });
    expect(activeToken('mail me@example.com', 19)).toBeNull();
    expect(activeToken('/pl', 3)).toEqual({ trigger: '/', query: 'pl', start: 0, end: 3 });
    expect(activeToken('first line\n/ne', 14)).toEqual({ trigger: '/', query: 'ne', start: 11, end: 14 });
    expect(activeToken('see src/app.ts', 14)).toBeNull();
    expect(activeToken('@src done', 9)).toBeNull();
  });

  it('replaces the token and puts the caret after the inserted text', () => {
    const text = 'open @Comp please';
    const token = activeToken(text, 10)!;
    expect(replaceToken(text, token, '@src/Composer.tsx')).toEqual({ text: 'open @src/Composer.tsx please', caret: 23 });
    expect(replaceToken('/new', activeToken('/new', 4)!, '')).toEqual({ text: '', caret: 0 });
  });

  it('ranks file-name prefixes above path substrings and fuzzy matches', () => {
    const files = ['docs/composer-notes.md', 'src/renderer/Composer.tsx', 'src/comp/other.ts', 'src/main/c-o-m-p.ts'];
    expect(rankMentions(files, 'comp', (f) => f, 10, true)[0]).toBe('src/renderer/Composer.tsx');
    expect(matchScore('abc', 'xyz')).toBe(-1);
    expect(matchScore('src/main/c-o-m-p.ts', 'comp', true)).toBeGreaterThan(0);
  });

  it('names referenced conversations safely', () => {
    expect(referenceFileName('thread', 'Fix the Login / Sign-up flow!')).toBe('thread-fix-the-login-sign-up-flow.md');
    expect(referenceFileName('chat', '***')).toBe('chat-chat.md');
  });
});
