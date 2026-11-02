// "Visual blocks": when a user asks for a diagram or chart, the agent is
// instructed (see VISUAL_OUTPUT_INSTRUCTION in the main process) to answer
// with one fenced ```html block holding a self-contained HTML/SVG fragment.
// The renderer turns those blocks into live visuals; everything else stays
// markdown. This module is the pure, testable half: splitting and making a
// fragment safe to place in a sandboxed frame.

export type VisualSegment =
  | { type: 'markdown'; text: string }
  | { type: 'html'; code: string; complete: boolean }
  | { type: 'mermaid'; code: string; complete: boolean };

const FENCE = /```(html|visual|diagram|mermaid|svg)[^\S\r\n]*\r?\n([\s\S]*?)(?:```|$)/g;

export function splitVisualBlocks(text: string): VisualSegment[] {
  const segments: VisualSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ type: 'markdown', text: text.slice(last, start) });
    const code = match[2] ?? '';
    // A match that ran to end-of-string without a closing fence is a visual
    // still streaming in; the UI shows it assembling instead of half a diagram.
    const complete = match[0].endsWith('```');
    segments.push(match[1] === 'mermaid' ? { type: 'mermaid', code, complete } : { type: 'html', code, complete });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'markdown', text: text.slice(last) });
  return segments.filter((s) => s.type !== 'markdown' || s.text.trim() !== '');
}

/**
 * Make a model-supplied fragment safe for a scriptless sandboxed frame.
 * Defence in depth — the frame also runs with no script permission and an
 * opaque origin — but nothing executable or external should survive:
 * script-bearing elements, event handlers, javascript: URLs, and external
 * resource references are removed. Inline styles and SVG stay.
 */
export function sanitizeVisualHtml(code: string): string {
  return code
    .replace(/<(script|iframe|object|embed|link|meta|base|form|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|link|meta|base|form|input|button)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '')
    .replace(/\s(?:href|src|xlink:href)\s*=\s*("\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*')/gi, '')
    .replace(/url\(\s*(?!['"]?data:)['"]?https?:[^)]*\)/gi, 'none')
    .trim();
}

const ASSEMBLY_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; }
  .cv-root { padding: 10px; overflow: hidden; }
  .cv-root svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  @keyframes cv-in {
    from { opacity: 0; transform: translateY(10px) scale(0.96); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes cv-grow {
    from { opacity: 0; transform: scaleY(0.15); }
    to { opacity: 1; transform: scaleY(1); }
  }
  .cv-root > * { animation: cv-in 0.45s cubic-bezier(0.22, 0.9, 0.3, 1) both; transform-box: fill-box; transform-origin: center; }
  .cv-root > *:nth-child(2) { animation-delay: 0.07s; }
  .cv-root > *:nth-child(3) { animation-delay: 0.14s; }
  .cv-root > *:nth-child(4) { animation-delay: 0.21s; }
  .cv-root > *:nth-child(5) { animation-delay: 0.28s; }
  .cv-root > *:nth-child(6) { animation-delay: 0.35s; }
  .cv-root > *:nth-child(n+7) { animation-delay: 0.42s; }
  .cv-root svg :where(path, circle, rect, line, polyline, polygon, ellipse, text, g) {
    animation: cv-in 0.4s cubic-bezier(0.22, 0.9, 0.3, 1) both;
    transform-box: fill-box; transform-origin: center;
  }
  .cv-root svg :nth-child(2) { animation-delay: 0.06s; }
  .cv-root svg :nth-child(3) { animation-delay: 0.12s; }
  .cv-root svg :nth-child(4) { animation-delay: 0.18s; }
  .cv-root svg :nth-child(5) { animation-delay: 0.24s; }
  .cv-root svg :nth-child(6) { animation-delay: 0.30s; }
  .cv-root svg :nth-child(7) { animation-delay: 0.36s; }
  .cv-root svg :nth-child(8) { animation-delay: 0.42s; }
  .cv-root svg :nth-child(9) { animation-delay: 0.48s; }
  .cv-root svg :nth-child(10) { animation-delay: 0.54s; }
  .cv-root svg :nth-child(n+11) { animation-delay: 0.6s; }
  .cv-root svg rect { animation-name: cv-grow; transform-origin: bottom; }
  @media (prefers-reduced-motion: reduce) {
    .cv-root *, .cv-root svg * { animation: none !important; }
  }
`;

/** The full srcDoc for the sandboxed frame: our assembly styles + the fragment. */
export function buildVisualSrcDoc(code: string, dark: boolean): string {
  const fragment = sanitizeVisualHtml(code);
  const foreground = dark ? '#e6ede3' : '#1d2822';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    html, body { overflow: hidden; }
    body { margin: 0; }
    body { color: ${foreground}; }
    ${ASSEMBLY_CSS}
  </style></head><body><div class="cv-root">${fragment}</div></body></html>`;
}

/**
 * Make an agent-supplied SVG loadable as an <img> (for rasterizing into
 * documents): extract the <svg> element, sanitize it, repair bare `&`,
 * ensure a namespace, and give it explicit dimensions — an SVG with only
 * a viewBox and malformed entities is the usual "could not render" cause.
 * Returns null when the fragment contains no SVG at all.
 */
export function normalizeSvgForImage(fragment: string): string | null {
  const match = /<svg[\s\S]*?<\/svg>/i.exec(fragment);
  const raw = match !== null ? match[0] : fragment.trim().startsWith('<svg') ? fragment.trim() : null;
  if (raw === null) return null;
  // HTML named entities (&nbsp;, &copy;, …) are undefined in XML and make
  // the whole SVG unloadable as an image; convert the common ones to
  // numeric form and escape any others, plus stray "<" and void elements.
  const NAMED_ENTITIES: Record<string, number> = {
    nbsp: 160, copy: 169, reg: 174, trade: 8482, hellip: 8230, mdash: 8212, ndash: 8211,
    lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, bull: 8226, middot: 183,
    laquo: 171, raquo: 187, deg: 176, plusmn: 177, times: 215, divide: 247,
    ne: 8800, le: 8804, ge: 8805, rarr: 8594, larr: 8592, uarr: 8593, darr: 8595,
    infin: 8734, sum: 8721, prod: 8719, minus: 8722, lowast: 8727, radic: 8730, prop: 8733,
    alpha: 945, beta: 946, gamma: 947, delta: 948, epsilon: 949, zeta: 950, eta: 951, theta: 952,
    lambda: 955, mu: 956, pi: 960, sigma: 963, tau: 964, phi: 966, omega: 969,
  };
  let svg = sanitizeVisualHtml(raw)
    .replace(/&(\w+);/g, (whole, name: string) => {
      if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return whole;
      const code = NAMED_ENTITIES[name];
      return code !== undefined ? `&#${code};` : `&amp;${name};`;
    })
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;')
    .replace(/<(?![a-zA-Z/!?])/g, '&lt;')
    .replace(/<(br|hr|img|input|link|meta)([^>]*[^/])>/g, '<$1$2/>');
  if (!/xmlns\s*=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const viewBox = /viewBox\s*=\s*"([\d.\s-]+)"/i.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
  const hasWidth = /\swidth\s*=/.test(svg);
  const hasHeight = /\sheight\s*=/.test(svg);
  if (!hasWidth || !hasHeight) {
    const width = viewBox !== undefined && viewBox.length === 4 && viewBox[2]! > 0 ? Math.round(viewBox[2]!) : 1200;
    const height = viewBox !== undefined && viewBox.length === 4 && viewBox[3]! > 0 ? Math.round(viewBox[3]!) : 800;
    svg = svg.replace('<svg', `<svg${hasWidth ? '' : ` width="${width}"`}${hasHeight ? '' : ` height="${height}"`}`);
  }
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (doc.querySelector('parsererror') === null) return new XMLSerializer().serializeToString(doc.documentElement);
    } catch { /* fall through to the repaired text */ }
  }
  return svg;
}

export type VideoUrlSegment = { type: 'text'; text: string } | { type: 'video'; url: string };

const VIDEO_URL = /(https?:\/\/[^\s<>()'"\]]+?\.(?:mp4|webm|mov)(?:\?[^\s<>()'"\]]*)?)/gi;

/** Direct video-file URLs in a reply (e.g. a generation MCP tool's result)
 *  become inline players instead of inert link text. */
export function splitVideoUrls(text: string): VideoUrlSegment[] {
  const segments: VideoUrlSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(VIDEO_URL)) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ type: 'text', text: text.slice(last, at) });
    segments.push({ type: 'video', url: match[1]! });
    last = at + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) });
  return segments.filter((s) => s.type !== 'text' || s.text !== '');
}

/** Aspect ratio from the fragment's first SVG viewBox, if it has one. */
export function visualAspectRatio(code: string): number | null {
  const match = /viewBox\s*=\s*"([\d.\s-]+)"/i.exec(code);
  if (match === null) return null;
  const parts = (match[1] ?? '').trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n)) || parts[2] === 0 || parts[3] === 0) return null;
  return parts[2]! / parts[3]!;
}
