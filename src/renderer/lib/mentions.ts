// @-mentions and /-commands in the message boxes: finding the token being
// typed at the caret, ranking candidates, and replacing the token.

export type MentionTrigger = '@' | '/';

export interface ActiveToken {
  trigger: MentionTrigger;
  /** Text typed after the trigger, up to the caret. */
  query: string;
  /** Index of the trigger character. */
  start: number;
  /** The caret. */
  end: number;
}

/**
 * The @ or / token the caret is in, if any. `@` starts a token at the start
 * of the text or after whitespace; `/` only at the start of a line, so paths
 * and fractions in prose never open the menu.
 */
export function activeToken(text: string, caret: number): ActiveToken | null {
  if (caret < 0 || caret > text.length) return null;
  let index = caret - 1;
  while (index >= 0 && !/\s/.test(text[index]!)) {
    const char = text[index]!;
    if (char === '@' || char === '/') {
      const before = index === 0 ? '' : text[index - 1]!;
      const query = text.slice(index + 1, caret);
      if (char === '@' && (before === '' || /\s/.test(before))) return { trigger: '@', query, start: index, end: caret };
      if (char === '/' && (before === '' || before === '\n') && !query.includes('/')) return { trigger: '/', query, start: index, end: caret };
    }
    index -= 1;
  }
  return null;
}

/** Replace the token with `insertion` (plus a trailing space); returns the new text and caret. */
export function replaceToken(text: string, token: ActiveToken, insertion: string): { text: string; caret: number } {
  const after = text.slice(token.end);
  const spacer = insertion === '' || after.startsWith(' ') ? '' : ' ';
  const next = text.slice(0, token.start) + insertion + spacer + after;
  const caret = token.start + insertion.length + spacer.length + (insertion !== '' && after.startsWith(' ') ? 1 : 0);
  return { text: next, caret };
}

/**
 * How well `query` matches `label` (higher is better), or -1 for no match.
 * Prefix and word-start matches beat substrings; for paths the file name
 * counts most. Characters in order (fuzzy) is the weakest match.
 */
export function matchScore(label: string, query: string, isPath = false): number {
  const q = query.trim().toLowerCase();
  if (q === '') return 1;
  const text = label.toLowerCase();
  const base = isPath ? text.slice(text.lastIndexOf('/') + 1) : text;
  if (base === q) return 100;
  if (base.startsWith(q)) return 80 - Math.min(base.length - q.length, 30) / 2;
  if (new RegExp(`(^|[\\s/._-])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) return 60;
  const at = text.indexOf(q);
  if (at >= 0) return 40 - Math.min(at, 20) / 2;
  let position = 0;
  for (const char of q) {
    position = text.indexOf(char, position);
    if (position === -1) return -1;
    position += 1;
  }
  return 10;
}

/** Items matching `query`, best first, at most `limit`. */
export function rankMentions<T>(items: readonly T[], query: string, label: (item: T) => string, limit: number, isPath = false): T[] {
  return items
    .map((item, index) => ({ item, index, score: matchScore(label(item), query, isPath) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** A Markdown document as a draft attachment file (for useAttachmentDraft.addFiles). */
export function markdownDraftFile(name: string, markdown: string): { name: string; size: number; type: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  const bytes = new TextEncoder().encode(markdown);
  return { name, size: bytes.byteLength, type: 'text/markdown', arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer) };
}

/** A safe Markdown file name for a referenced conversation. */
export function referenceFileName(kind: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || kind;
  return `${kind}-${slug}.md`;
}
