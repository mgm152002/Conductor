import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: resolve(__dirname, '../..'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': resolve(__dirname, '../../src/shared') } },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
