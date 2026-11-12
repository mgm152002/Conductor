import style from './web/style.css?raw';
import script from './web/app.js?raw';

// The phone's page: one self-contained HTML document (no external requests,
// strict CSP with a per-response nonce). The look is in web/style.css and the
// behaviour in web/app.js. It talks to /api/* with the token it got by
// trading the QR code's one-time pairing code.

export function mobilePage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">`
    + `<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">`
    + `<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">`
    + `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="theme-color" content="#a8289a">`
    + `<title>Conductor</title><style nonce="${nonce}">${style}</style></head>`
    + `<body><div id="app" class="app"></div><script nonce="${nonce}">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
