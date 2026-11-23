// Splits markdown into top-level blocks that render the same on their own as
// they do together. A streaming reply only ever grows at its end, so when each
// block is rendered (and memoised) separately, a new chunk re-parses just the
// last block instead of the whole reply — the difference between a reply that
// keeps up and one that stutters on a slow machine.
//
// The split is deliberately conservative. It only cuts at a blank line,
// outside a code fence, where the next line starts a fresh, unindented block
// that is not a list item (so lists, nested content and loose lists stay in
// one piece). Text with link reference definitions or footnotes, which refer
// across blocks, is never split.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[*+-]|\d{1,9}[.)])(?:\s|$)/;
const REFERENCE = /^ {0,3}\[[^\]\n]+\]:/m;

export function splitMarkdownBlocks(text: string): string[] {
  if (REFERENCE.test(text)) return [text];
  const lines = text.split('\n');
  const blocks: string[] = [];
  let start = 0;
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = FENCE.exec(line);
    if (fence !== null) {
      if (marker !== null && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && line.trim() === marker[1]) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    if (line.trim() !== '') continue;
    // A blank line: cut here only if the next non-blank line starts a new,
    // unindented, non-list block.
    let next = index + 1;
    while (next < lines.length && lines[next]!.trim() === '') next += 1;
    if (next >= lines.length) break;
    const following = lines[next]!;
    if (/^\s/.test(following) || LIST_ITEM.test(following)) continue;
    const block = lines.slice(start, index).join('\n');
    if (block.trim() !== '') blocks.push(block);
    start = next;
    index = next - 1;
  }
  const rest = lines.slice(start).join('\n');
  if (rest.trim() !== '' || blocks.length === 0) blocks.push(rest);
  return blocks;
}
