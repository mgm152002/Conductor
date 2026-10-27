import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests run in the Node (main-process) environment. The renderer is covered by
// separate component tests later; the orchestrator, store, registry, and IPC
// wrappers are the primary units under test and all run under Node.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.ts'],
    globals: false,
  },
});
