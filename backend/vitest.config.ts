import { defineConfig } from 'vitest/config'
import { testDatabaseUrl } from './scripts/test-db-url.js'

/**
 * Backend test config. Two jobs, both defensive.
 *
 * 1. POINT THE TESTS AT THEIR OWN DATABASE. They used to share `hubworld_dev`
 *    with the dev server, whose settlement sweep runs every 15s and deletes
 *    fixtures mid-test — measured at ~20% of full-suite runs failing with the
 *    server up and 0% with it stopped. Stryker's concurrent workers collide the
 *    same way, and that collision is why `src/ledger.ts` cannot be mutated.
 *
 *    Set here rather than in a setup file because `src/env.ts` reads
 *    DATABASE_URL at import time. dotenv does not overwrite variables that are
 *    already set, so this wins over `.env` without touching it. CI already
 *    points at a `hubworld_test` database, so the swap is a no-op there.
 *
 * 2. EXCLUDE `.stryker-tmp`. Stryker copies the whole project per run and only
 *    cleans up on SUCCESS, so a crashed run leaves working copies of every suite
 *    on disk. Vitest's default glob then finds them: one interrupted run turned
 *    313 tests into 925, with 131 failing against stale fixtures.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.stryker-tmp/**', 'reports/**'],
    env: { DATABASE_URL: testDatabaseUrl() },
    globalSetup: ['./tests/global-setup.ts'],
  },
})
