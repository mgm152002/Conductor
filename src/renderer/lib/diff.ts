// Classifies unified-diff lines for the Files panel's compact diff viewer.
// Only presentation is derived here; the patch itself is produced and bounded
// by the main process.

export type DiffLineKind = 'add' | 'delete' | 'hunk' | 'header' | 'context';

const HEADER_PREFIXES = [
  'diff --git ',
  'index ',
  'new file mode ',
  'deleted file mode ',
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  '--- ',
  '+++ ',
  'Binary files ',
  'GIT binary patch',
];

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) return 'header';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'delete';
  return 'context';
}
