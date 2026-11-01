import { defineConfig, devices } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * The Privy end-to-end journey, run against the LOCAL STACK (real test network, Xaman pretended).
 *
 *   backend:  scripts/local-stack.sh start      (and `event` once, so there is something to buy)
 *   frontend: npm run e2e:privy
 *
 * Separate from `npm run e2e` on purpose. That suite runs its own stack in stub mode and costs nothing; this one signs in
 * through Privy's real service and spends test-network XRP, so it only runs when asked. It starts no servers: Privy only
 * accepts origins listed in its dashboard, and the local stack's :5175 is one of them.
 *
 * The Privy test account comes from ~/.hubworld-privy.env (PRIVY_TEST_EMAIL, PRIVY_TEST_OTP). Read here, put in the test
 * process's environment, never printed, never in the repo.
 */
const PRIVY_ENV = path.join(homedir(), '.hubworld-privy.env')
if (existsSync(PRIVY_ENV)) {
  for (const line of readFileSync(PRIVY_ENV, 'utf8').split('\n')) {
    const m = /^(PRIVY_TEST_EMAIL|PRIVY_TEST_OTP)=(.+)$/.exec(line.trim())
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
}

export const WEB = process.env.E2E_WEB ?? 'http://localhost:5175'
export const API = process.env.E2E_API ?? 'http://localhost:4001/api'

export default defineConfig({
  testDir: './e2e-privy',
  workers: 1,
  retries: 0,
  // Real ledger closes and a real purchase: minutes, not seconds.
  timeout: 6 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-privy' }]],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A trace records typed text, so the one-time code would be in it. Keep traces local (they are gitignored); never share one.
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
})
