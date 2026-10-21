import type { Difficulty } from '@shared/agent-models';

// Project context sent with a request costs tokens on every model call the
// agent makes, so its size follows the request's difficulty.

export const CONTEXT_BUDGET: Record<Difficulty, number> = { simple: 4_000, moderate: 8_000, complex: 16_000 };
const PER_ITEM = 1_500;

/** Keep context items in order until `maxChars`, trimming long items. */
export function capContext<T extends Record<string, unknown>>(items: T[], maxChars: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (const item of items) {
    const content = typeof item['content'] === 'string' ? item['content'] as string : undefined;
    const trimmed = content !== undefined && content.length > PER_ITEM ? { ...item, content: `${content.slice(0, PER_ITEM)}… (truncated)` } : item;
    const size = JSON.stringify(trimmed).length;
    if (used + size > maxChars) break;
    out.push(trimmed);
    used += size;
  }
  return out;
}
