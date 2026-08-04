import { defineConfig } from 'vitest/config'

/**
 * Backend test config.
 *
 * It exists for `exclude`. Stryker copies the whole project into
 * `.stryker-tmp/sandbox-*` for every run, tests included, and only cleans up
 * when a run SUCCEEDS — so a crashed or interrupted mutation run leaves working
 * copies of every suite on disk. Vitest's default glob then finds them: one
 * interrupted run turned 313 tests into 925, with 131 failing against stale
 * fixtures in a directory nobody meant to keep.
 *
 * That failure is loud but deeply confusing, and it is not the sort of thing to
 * rediscover at 2am. Excluding the sandbox makes it impossible.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.stryker-tmp/**', 'reports/**'],
  },
})
