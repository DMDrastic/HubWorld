/**
 * Which signing affordance appears, on which device.
 *
 * This is the spec that justifies Playwright existing here. A QR is an
 * instruction to a SECOND device: right on a desktop, a dead end on a phone,
 * where you cannot scan the screen you are reading. The fix renders Xaman's
 * deep link instead below the `sm` breakpoint — and jsdom has no viewport, so
 * the unit tests can only assert that the link renders, never that the QR is
 * actually GONE at a real device size. That last mile was checked by hand on an
 * iPhone 12 and had no automated cover until now.
 *
 * These servers run in stub mode, which deliberately withholds the deep link
 * (stub `next` is `hubworld-stub://sign/<uuid>`, a scheme that opens nothing).
 * So the two device tests intercept the sign-in response and hand back a
 * LIVE-mode payload. That is not weakening the test: the component, the CSS,
 * the browser and the viewport are all real, and the response is the only thing
 * faked — which is the same seam the unit tests already use, moved into a real
 * browser where layout can actually be observed.
 *
 * The third test uses the genuine stub backend, because "no link in stub mode"
 * is precisely a fact about the real server.
 */
import { test, expect } from '@playwright/test'

/** A live-mode sign-in payload, as real Xaman would return it. */
const LIVE_PAYLOAD = {
  uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  next: 'https://xumm.app/sign/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  qrPng: 'https://xumm.app/sign/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee_q.png',
  expiresAt: new Date(Date.now() + 180_000).toISOString(),
  mode: 'live',
}

async function stubLiveSignIn(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/signin', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill({ status: 201, json: LIVE_PAYLOAD })
  })
  // The poll must not resolve, or the prompt disappears before we can look.
  await page.route('**/api/auth/signin/*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ status: 200, json: { state: 'pending' } })
  })
  // The QR image is remote; never let a test depend on Xaman's CDN.
  await page.route('**/*_q.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }),
  )
}

test.describe('the sign-in prompt', () => {
  test('on a phone: a deep link, and no QR to scan', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'device-specific')
    await stubLiveSignIn(page)

    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('link', { name: /open in xaman/i })).toBeVisible()

    // The point of the whole change: on a phone the QR is not merely small, it
    // is not shown. This is the assertion jsdom could never make.
    await expect(page.getByAltText(/sign-in qr/i)).toBeHidden()
  })

  test('on a desktop: the QR leads, the link is secondary', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'device-specific')
    await stubLiveSignIn(page)

    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByAltText(/sign-in qr/i)).toBeVisible()
    // Still offered — someone may be browsing on the phone that will sign.
    await expect(page.getByRole('link', { name: /open in xaman/i })).toBeVisible()
  })

  test('the real stub server offers no link, because it would open nothing', async ({ page }) => {
    // No interception: this is the actual backend, running without Xaman
    // credentials, so `next` is hubworld-stub://sign/<uuid>. A control that
    // visibly does nothing is worse than no control, and would only reveal
    // itself when someone tapped it mid-demo.
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByAltText(/sign-in qr/i)).toBeAttached()
    await expect(page.getByRole('link', { name: /open in xaman/i })).toHaveCount(0)
  })
})
