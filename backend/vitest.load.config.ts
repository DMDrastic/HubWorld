import { defineConfig } from 'vitest/config'
import { testDatabaseUrl } from './scripts/test-db-url.js'

/**
 * The sweep load test, run ALONE.
 *
 * `npm run test:load`. Deliberately outside `npm test`, for the same reason
 * Playwright is: it answers a question the fast loop structurally cannot, and
 * it cannot share the loop's conditions.
 *
 * `settleDueAuctions` sweeps every due auction in the database and takes 25 at
 * a time. A load fixture is therefore not inert — thirty auctions closing at
 * once fill that batch, and any suite sweeping concurrently finds its own
 * auction starved and fails. Measured while building this: the full suite was
 * clean over six consecutive runs without this file and failed roughly one run
 * in three with it, always in a NEIGHBOURING suite. The fixture was the load
 * being tested; it just applied to everyone.
 *
 * So it gets its own run with `fileParallelism` off and nothing beside it.
 * Same database as the rest — `hubworld_test`, never the dev one — so it still
 * cannot be perturbed by a running dev server's sweep.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.loadtest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.stryker-tmp/**', 'reports/**'],
    env: { DATABASE_URL: testDatabaseUrl() },
    globalSetup: ['./tests/global-setup.ts'],
    fileParallelism: false,
  },
})
