import { defineConfig } from 'tsdown'

/**
 * Vendored protocol has no invariant.ts (the original package's invariant
 * imports @deepseek-ai/dsh-invariants, which is not a standalone dependency),
 * so its bundle entry is just the type surface. The typert generator runs from
 * the root config's workspace pass.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
