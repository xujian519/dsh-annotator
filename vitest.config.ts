/** Test configuration: node by default, jsdom where a spec asks for it. */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      // Every source file, every metric. An uncovered line is a deletion
      // candidate or a missing test, never a number to lower.
      thresholds: {
        perFile: true,
        lines: 100,
        statements: 100,
        branches: 100,
        functions: 100,
      },
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
})
