import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'inlaycms' } },
  resolve: {
    alias: [
      { find: /^inlaycms\/jsx-runtime$/, replacement: src('./src/jsx/jsx-runtime.ts') },
      { find: /^inlaycms\/jsx-dev-runtime$/, replacement: src('./src/jsx/jsx-dev-runtime.ts') },
      { find: /^inlaycms\/site$/, replacement: src('./src/site.ts') },
      { find: /^inlaycms\/testing$/, replacement: src('./src/testing.ts') },
      { find: /^inlaycms$/, replacement: src('./src/index.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: true,
    globalSetup: ['tests/setup/admin-assets.ts'],
    setupFiles: ['tests/setup/fast-passwords.ts'],
  },
})
