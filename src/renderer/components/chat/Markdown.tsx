import { createContext, useContext, isValidElement, type ReactNode } from 'react';
import type { Element } from 'hast';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';

/** Context to signal whether inline code is inside a `<pre>` code block. */
const InPreContext = createContext(false);

/** Context to track list nesting depth for indentation. */
const ListDepthContext = createContext(0);

const components: Components = {
  h1: ({ node: _node, children, className, ...props }) => (
    <h1 className={cn('text-base font-semibold text-foreground', className)} {...props}>
      {children}
    </h1>
  ),
  h2: ({ node: _node, children, className, ...props }) => (
    <h2 className={cn('text-base font-semibold text-foreground', className)} {...props}>
      {children}
    </h2>
  ),
  h3: ({ node: _node, children, className, ...props }) => (
    <h3 className={cn('text-sm font-semibold text-foreground', className)} {...props}>
      {children}
    </h3>
  ),
  h4: ({ node: _node, children, className, ...props }) => (
    <h4 className={cn('text-sm font-semibold text-foreground', className)} {...props}>
      {children}
    </h4>
  ),
  h5: ({ node: _node, children, className, ...props }) => (
    <h5 className={cn('text-sm font-semibold text-foreground', className)} {...props}>
      {children}
    </h5>
  ),
  h6: ({ node: _node, children, className, ...props }) => (
    <h6 className={cn('text-xs font-semibold text-muted-foreground', className)} {...props}>
      {children}
    </h6>
  ),
  p: ({ node: _node, children, className, ...props }) => (
    <p className={cn('whitespace-pre-wrap leading-relaxed', className)} {...props}>
      {children}
    </p>
  ),
  strong: ({ node: _node, children, className, ...props }) => (
    <strong className={cn('font-semibold text-foreground', className)} {...props}>
      {children}
    </strong>
  ),
  em: ({ node: _node, children, className, ...props }) => (
    <em className={cn('italic', className)} {...props}>
      {children}
    </em>
  ),
  del: ({ node: _node, children, className, ...props }) => (
    <del className={cn('line-through text-muted-foreground', className)} {...props}>
      {children}
    </del>
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr className={cn('my-2 border-t border-border', className)} {...props} />
  ),
  blockquote: ({ node: _node, children, className, ...props }) => (
    <blockquote
      className={cn(
        'flex flex-col gap-2 border-l-2 border-border pl-3 text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </blockquote>
  ),
  ul: ({ node: _node, className, children, ...props }) => {
    const depth = useContext(ListDepthContext);
    const isTaskList = className?.includes('contains-task-list');
    return (
      <ListDepthContext.Provider value={depth + 1}>
        <ul
          className={cn(
            'flex flex-col gap-1',
            isTaskList
              ? depth === 0
                ? 'list-none pl-1'
                : 'list-none pl-5'
              : 'list-disc pl-5 marker:text-muted-foreground',
            className,
          )}
          {...props}
        >
          {children}
        </ul>
      </ListDepthContext.Provider>
    );
  },
  ol: ({ node: _node, className, children, ...props }) => {
    const depth = useContext(ListDepthContext);
    return (
      <ListDepthContext.Provider value={depth + 1}>
        <ol
          className={cn(
            'flex flex-col gap-1 pl-5 list-decimal marker:text-muted-foreground',
            className,
          )}
          {...props}
        >
          {children}
        </ol>
      </ListDepthContext.Provider>
    );
  },
  li: ({ node: _node, className, children, ...props }) => {
    const isTaskItem = className?.includes('task-list-item');
    return (
      <li
        className={cn('leading-relaxed', isTaskItem && 'list-none', className)}
        {...props}
      >
        {children}
      </li>
    );
  },
  input: ({ node: _node, type, checked, disabled, className, ...props }) => {
    if (type === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled ?? true}
          readOnly
          className={cn(
            'mr-2 size-3.5 shrink-0 cursor-default rounded border border-border accent-primary align-middle pointer-events-none',
            className,
          )}
          {...props}
        />
      );
    }
    return <input type={type} checked={checked} disabled={disabled} className={className} {...props} />;
  },
  // Links are kept completely inert so renderer navigation remains locked to the app.
  a: ({ node: _node, href, title, children, className, ...props }) => (
    <span
      className={cn(
        'text-primary underline decoration-primary/40 underline-offset-2 break-all',
        className,
      )}
      title={href || title}
      {...props}
    >
      {children}
    </span>
  ),
  pre: ({ node, children, className, ...props }) => {
    let lang = '';
    if (node && 'children' in node && Array.isArray(node.children)) {
      const codeChild = node.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'code',
      );
      if (codeChild?.properties?.className) {
        const classNames = Array.isArray(codeChild.properties.className)
          ? codeChild.properties.className
          : [codeChild.properties.className];
        const langClass = classNames.find(
          (cls): cls is string => typeof cls === 'string' && cls.startsWith('language-'),
        );
        if (langClass) {
          lang = langClass.replace(/^language-/, '');
        }
      }
    }
    if (!lang && isValidElement(children)) {
      const childProps = children.props as { className?: string };
      const match = /language-(\S+)/.exec(childProps?.className ?? '');
      if (match) {
        lang = match[1]!;
      }
    }

    return (
      <div className="my-1 overflow-hidden rounded-xl border border-border bg-code">
        {lang ? (
          <div className="border-b border-border px-3 py-1 font-mono text-3xs text-muted-foreground">
            {lang}
          </div>
        ) : null}
        <InPreContext.Provider value={true}>
          <pre
            className={cn('overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed', className)}
            {...props}
          >
            {children}
          </pre>
        </InPreContext.Provider>
      </div>
    );
  },
  code: ({ node: _node, children, className, ...props }) => {
    const inPre = useContext(InPreContext);
    if (inPre) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(
          'rounded-md border border-border bg-code px-1 py-px font-mono text-[0.85em]',
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
  table: ({ node: _node, children, className, ...props }) => (
    <div className="my-1 max-w-full overflow-x-auto rounded-xl border border-border">
      <table className={cn('w-full border-collapse text-left text-xs', className)} {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ node: _node, children, className, ...props }) => (
    <thead
      className={cn('border-b border-border bg-muted/50 font-medium text-muted-foreground', className)}
      {...props}
    >
      {children}
    </thead>
  ),
  tbody: ({ node: _node, children, className, ...props }) => (
    <tbody className={cn('divide-y divide-border', className)} {...props}>
      {children}
    </tbody>
  ),
  tr: ({ node: _node, children, className, ...props }) => (
    <tr className={cn('transition-colors hover:bg-muted/20', className)} {...props}>
      {children}
    </tr>
  ),
  th: ({ node: _node, children, className, ...props }) => (
    <th className={cn('px-3 py-2 text-left font-medium text-foreground', className)} {...props}>
      {children}
    </th>
  ),
  td: ({ node: _node, children, className, ...props }) => (
    <td className={cn('px-3 py-2 text-foreground align-top', className)} {...props}>
      {children}
    </td>
  ),
  img: ({ node: _node, src, alt, className, ...props }) => (
    <img
      src={src}
      alt={alt}
      className={cn('max-w-full rounded-lg border border-border', className)}
      {...props}
    />
  ),
};

export interface MarkdownProps {
  /** The Markdown source text. Supports assistant replies or attachment previews. */
  text?: string;
  /** Children prop alternative to `text`. */
  children?: ReactNode;
  /** Optional class names applied to the outer container. */
  className?: string;
}

/**
 * Renders GitHub Flavored Markdown (GFM) using react-markdown and remark-gfm.
 * Raw HTML is disallowed, and links are rendered inert as text spans so that
 * renderer navigation remains locked to the app. Tables support horizontal
 * scrolling when wide. Usable for streaming assistant replies and attachment previews.
 */
export function Markdown({ text, children, className }: MarkdownProps): React.JSX.Element {
  const content = typeof text === 'string' ? text : typeof children === 'string' ? children : '';

  return (
    <div className={cn('flex flex-col gap-3 text-sm leading-relaxed break-words text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml={true}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
