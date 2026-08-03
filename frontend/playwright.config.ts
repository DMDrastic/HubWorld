import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * End-to-end tests, in a real browser, against a real stack.
 *
 * These exist for the things jsdom structurally cannot answer, not to restate
 * what the unit tests already cover:
 *
 *   - VIEWPORT. Whether the QR is actually gone below the `sm` breakpoint is a
 *     question about layout in a browser. jsdom has no viewport at all, so the
 *     mobile deep-link work had to be verified by hand on a phone.
 *   - COOKIES. `httpOnly` and `SameSite=Lax` are the whole session design and
 *     jsdom fakes both.
 *   - THE SPA FALLBACK. Loading /tickets directly and refreshing is a documented
 *     deploy hazard that nothing tested.
 *   - TIMING. The sign-out bug lived in the window of a network round trip.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS ABOUT HOW THE BACKEND IS LAUNCHED, BOTH DELIBERATE
 *
 * 1. STUB MODE. Signing flows need `POST /auth/signin/simulate`, which only
 *    exists when Xaman credentials are absent. It also means these tests cost
 *    NOTHING against the Xaman payload quota — the constraint that has bitten
 *    this project hardest. Credentials are excluded by pointing
 *    DOTENV_CONFIG_PATH at a file that does not exist, so `dotenv/config` loads
 *    nothing and this file supplies the entire environment explicitly.
 *
 *    Note what does NOT work: setting XAMAN_API_KEY='' . The schema is
 *    `.min(1).optional()`, so an empty string is present-but-invalid and the
 *    server exits at startup rather than falling back to stub.
 *
 * 2. ITS OWN PORTS. 4100/5273 rather than 4000/5173, so a run cannot fight the
 *    dev servers or — worse — quietly pass by talking to a LIVE-mode backend
 *    that was already running, where the stub endpoints are 404 and the QR
 *    assertions would be meaningless.
 *
 * DATABASE_URL is read out of backend/.env because it is machine-specific and
 * must not be committed. The dev database is reused deliberately: these specs
 * only read, or write a stub sign-in that cleans up after itself.
 * ---------------------------------------------------------------------------
 */
const BACKEND = path.resolve(import.meta.dirname, '../backend')
const API_PORT = 4100
const WEB_PORT = 5273

function devDatabaseUrl(): string {
  const env = readFileSync(path.join(BACKEND, '.env'), 'utf8')
  const line = env.split('\n').find((l) => l.startsWith('DATABASE_URL='))
  if (!line) throw new Error('No DATABASE_URL in backend/.env — e2e needs a database to point at.')
  return line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // one stack, one database
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // A real device descriptor, not just a narrow window: touch, device pixel
    // ratio and a mobile user agent. That fidelity is the reason for choosing
    // Playwright over a CSS-only viewport resize.
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],

  webServer: [
    {
      command: 'npm run dev',
      cwd: BACKEND,
      port: API_PORT,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: {
        // Points at nothing, so dotenv loads nothing and the vars below are the
        // whole environment — in particular, no Xaman credentials.
        DOTENV_CONFIG_PATH: path.join(BACKEND, '.env.e2e-intentionally-absent'),
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL: devDatabaseUrl(),
        CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        XRPL_NETWORK: 'testnet',
      },
    },
    {
      command: 'npm run dev',
      port: WEB_PORT,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: {
        ...process.env,
        VITE_PORT: String(WEB_PORT),
        VITE_API_TARGET: `http://localhost:${API_PORT}`,
      },
    },
  ],
})
