import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The renderer HTML carries a `<!--CSP-META-->` placeholder instead of a
// hardcoded Content-Security-Policy. This plugin substitutes the policy per
// mode so production stays locked down to 'self', while development also
// permits exactly what Vite's dev server injects and nothing more:
//   - script-src 'unsafe-inline': Vite injects an INLINE module preamble
//     (React Fast Refresh: injectIntoGlobalHook / $RefreshReg$). Without this
//     the preamble is blocked, Fast-Refresh globals are never defined, every
//     component module throws on load, and the window renders blank.
//   - connect-src ws:/wss: + the dev origin: the HMR client opens a WebSocket
//     back to the dev server.
// None of these dev allowances reach the packaged build.
function cspPlugin(isDev: boolean): Plugin {
  const prodCsp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'";
  const devCsp =
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${isDev ? devCsp : prodCsp}" />`;
  return {
    name: 'conductor-csp-inject',
    transformIndexHtml(html) {
      return html.replace('<!--CSP-META-->', meta);
    },
  };
}

// Three build targets — main (Node), preload (Node, sandbox-safe), and
// renderer (DOM).
//
// `main` externalizes node dependencies so native modules such as
// better-sqlite3 load from node_modules at runtime (it runs unsandboxed with a
// normal CommonJS require).
//
// `preload` does NOT externalize: it runs in a SANDBOXED context where `require`
// resolves only `electron` and Node built-ins — a bare `require('zod')` throws
// "module not found", aborting the preload before the context bridge is
// exposed. Bundling its dependencies (zod, the shared IPC contract) into the
// single preload file removes every runtime bare-module require.
export default defineConfig(({ mode }) => {
  const isDev = mode !== 'production';
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@shared': resolve(__dirname, 'src/shared'),
          '@main': resolve(__dirname, 'src/main'),
        },
      },
      build: {
        outDir: 'out/main',
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/main/index.ts') },
        },
      },
    },
    preload: {
      // No externalizeDepsPlugin: the sandboxed preload must bundle its deps.
      resolve: {
        alias: {
          '@shared': resolve(__dirname, 'src/shared'),
        },
      },
      build: {
        outDir: 'out/preload',
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/preload/index.ts') },
          // A sandboxed preload must be CommonJS; emit `.js` (not `.mjs`) so the
          // main process can load `../preload/index.js`.
          output: { format: 'cjs', entryFileNames: '[name].js' },
        },
      },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react(), tailwindcss(), cspPlugin(isDev)],
      resolve: {
        alias: {
          '@shared': resolve(__dirname, 'src/shared'),
          '@renderer': resolve(__dirname, 'src/renderer'),
        },
      },
      build: {
        outDir: 'out/renderer',
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/renderer/index.html') },
        },
      },
    },
  };
});
