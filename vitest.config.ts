import { defineConfig } from 'vitest/config';

// Unit tests: parser, patch engine, share/export helpers.
// Environment is happy-dom because `mermaid.parse()` needs a DOM
// (DOMPurify calls addHook). Playwright covers real rendering.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    globals: false,
    reporters: ['default'],
    testTimeout: 30000,
  },
});
