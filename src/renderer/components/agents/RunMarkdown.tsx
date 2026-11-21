import { Suspense, lazy } from 'react';

// Agent output in flows is Markdown; render it like the chat timeline does
// (lazily, so the markdown engine never blocks first paint).
const Markdown = lazy(() => import('../chat/Markdown').then((m) => ({ default: m.Markdown })));

export function RunMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <Suspense fallback={<p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground/85">{text}</p>}>
      <Markdown text={text} />
    </Suspense>
  );
}
