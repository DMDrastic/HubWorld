/**
 * Deep links, refreshes, and what a signed-out visitor is offered.
 *
 * The SPA fallback is the reason this file exists. The router owns /tickets,
 * /market and the rest, and those paths exist only in the browser — so the
 * server has to return index.html for any GET that accepts HTML. Vite does that
 * in dev, which is exactly why the gap is invisible until a deploy: without the
 * same rewrite, loading one of those URLs directly, or just refreshing, 404s on
 * a page that works fine when navigated to.
 *
 * No unit test can catch that. It is a fact about a server answering an HTTP
 * request, and jsdom never makes one.
 *
 * The gating tests restate a rule the unit tests also cover, deliberately: they
 * assert it survives a real navigation and a real reload, which is where a
 * client-side-only check would quietly stop applying.
 */
import { test, expect } from '@playwright/test'

const ROUTER_OWNED = ['/tickets', '/market', '/events', '/organize', '/door'] as const

test.describe('deep links the browser owns', () => {
  for (const route of ROUTER_OWNED) {
    test(`${route} loads directly, not just by navigation`, async ({ page }) => {
      const res = await page.goto(route)

      expect(res?.status(), `${route} must be served the app shell, not a 404`).toBe(200)
      // The shell rendered rather than an error page.
      await expect(page.getByRole('link', { name: 'HubWorld', exact: true })).toBeVisible()
    })
  }

  test('a refresh keeps you where you were', async ({ page }) => {
    // `exact` and `level` are both load-bearing. Playwright matches accessible
    // names by SUBSTRING, and EventList's second section heading reads "All
    // events" when nothing is live and "Everything else" when something is — so
    // a loose match here would pass or fail depending on whether a demo auction
    // happened to be running when the suite ran.
    const pageHeading = page.getByRole('heading', { name: 'Events', exact: true, level: 1 })

    await page.goto('/events')
    await expect(pageHeading).toBeVisible()

    await page.reload()

    // The failure this guards is landing on the shell but losing the route.
    await expect(pageHeading).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/events')
  })
})

test.describe('what a signed-out visitor is offered', () => {
  test('only Events — the rest describe an account', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('link', { name: 'Events', exact: true }).first()).toBeVisible()

    // Absent rather than disabled: a visible control advertises a capability
    // and invites someone to probe the endpoint behind it.
    //
    // `exact` matters — without it "Hub" matches the "HubWorld" brand link and
    // this fails for the wrong reason, which is exactly what it did first time.
    for (const label of ['Tickets', 'Market', 'Door', 'Organize', 'Hub']) {
      await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0)
    }
  })

  test('typing /organize gets an explanation, not a blank page or a 403', async ({ page }) => {
    await page.goto('/organize')

    await expect(page.getByRole('heading', { name: 'Organize' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  test('the events list is public, because it describes the world', async ({ page }) => {
    // Asking someone to connect a crypto wallet before they may even look at
    // what is on is the mistake the landing page was written to fix.
    await page.goto('/events')
    await expect(page.getByRole('heading', { name: 'Events', exact: true, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
  })
})
