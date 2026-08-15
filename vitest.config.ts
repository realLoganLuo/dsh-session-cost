import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from './vitest.shared.ts'

export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: [fileURLToPath(new URL('./tsconfig.base.json', import.meta.url))] }),
    standardDecoratorPlugin(),
  ],
  test: {

    include: ['packages/*/tests/**/*.spec.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['packages/*/src/types.ts', 'packages/typert-protocol/**'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        // The decorated service class carries one v8 synthetic `has` function
        // from the decorator transform that istanbul counts but source cannot
        // annotate (91.66% on that file, 98.82% overall); statements/branches/
        // lines stay at 100.
        functions: 90,
        lines: 100,
      },
      reporter: process.env.CI ? ['text'] : ['text', 'html'],
    },
  },
})
