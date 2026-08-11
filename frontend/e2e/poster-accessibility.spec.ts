/**
 * The one property about the poster that jsdom structurally cannot check.
 *
 * An event with no artwork gets a typographic fallback poster, and that poster
 * is `aria-hidden` — it is decoration, and a screen reader is told to skip it.
 * So the accessible name comes from a separate `sr-only` heading beside it.
 * Visually the title appears once; to a screen reader it also appears once; and
 * they are different elements.
 *
 * That arrangement is fragile in a specific, silent way. `sr-only` and `hidden`
 * differ by one word and by everything that matters: `hidden` is
 * `display: none`, which removes the heading from the accessibility tree and
 * puts the event's name nowhere at all — a user hears the date and the venue and
 * moves on, and heading navigation finds nothing on a page that is entirely a
 * list of events.
 *
 * **The unit tests cannot tell those apart.** jsdom loads no stylesheet, so both
 * are just a class string on an element that exists. Measured, not assumed:
 * swapping `sr-only` for `hidden` left all nine `EventPoster.test.tsx` cases
 * passing. This file exists for exactly that gap, and for nothing else.
 *
 * A real browser resolves the CSS, so both directions become checkable:
 *
 *   - `display: none`   -> Playwright's role engine will not match the heading
 *                          at all, because it is hidden from accessibility.
 *   - a plain visible h3 -> the heading has a full-size box, and the title is
 *                          then printed twice on screen, which is the other
 *                          failure the sr-only arrangement exists to avoid.
 *
 * Only genuinely screen-reader-only markup passes both.
 */
import { test, expect, type Page } from '@playwright/test'

type EventSummary = { title: string; imageUrl: string | null }

/**
 * An event with no artwork, taken from the running stack rather than fabricated.
 *
 * These specs read the dev database, so the fixture has to already be there.
 * Failing with the command to run beats skipping: a skipped test is a test that
 * cannot fail, and this one is the only coverage of the property it guards.
 */
async function anEventWithoutArtwork(page: Page): Promise<string> {
  const res = await page.request.get('/api/events')
  expect(res.ok(), 'GET /api/events must answer before this can assert anything').toBeTruthy()

  const { events } = (await res.json()) as { events: EventSummary[] }
  const bare = events.find((e) => !e.imageUrl)

  expect(
    bare,
    'No event without artwork in the dev database. Run `npm run demo:seed` in backend/ — ' +
      'this spec is about the FALLBACK poster, so an event with an image cannot exercise it.',
  ).toBeTruthy()

  return bare!.title
}

test.describe('an image-less poster names its event to a screen reader', () => {
  test('the title is a real heading in the accessibility tree', async ({ page }) => {
    const title = await anEventWithoutArtwork(page)
    await page.goto('/events')

    // Playwright's role engine excludes anything hidden from accessibility, so
    // this failing IS the `display: none` regression. It is not a proxy for it.
    const heading = page.getByRole('heading', { name: title, exact: true })

    await expect(
      heading,
      'The fallback poster is aria-hidden, so this heading is the ONLY copy of ' +
        'the event name a screen reader can reach. If it resolves to nothing, ' +
        'the title has been hidden with display:none rather than sr-only.',
    ).toBeAttached()
  })

  test('and that heading is not ALSO printed on screen', async ({ page }) => {
    const title = await anEventWithoutArtwork(page)
    await page.goto('/events')

    const box = await page.getByRole('heading', { name: title, exact: true }).first().boundingBox()

    // sr-only clips to a 1px box. Anything with real height is a visible
    // duplicate sitting under a poster that already sets the title large —
    // which reads as a rendering mistake rather than a caption, and is why the
    // caption was conditional in the first place.
    expect(box, 'the heading must exist to be measured').not.toBeNull()
    expect(
      box!.height,
      `The accessible heading is ${box!.height}px tall, so it is being SHOWN. ` +
        'The fallback poster already paints the title as artwork; this element ' +
        'is meant to be reachable and invisible.',
    ).toBeLessThan(4)
  })

  test('while the poster itself still shows the title to everyone else', async ({ page }) => {
    const title = await anEventWithoutArtwork(page)
    await page.goto('/events')

    // The control. Without it the two assertions above are satisfied by a page
    // that names the event to a screen reader and shows nothing to anybody
    // looking at it — which would be a worse bug than the one being guarded.
    const painted = page.locator('[aria-hidden="true"]').getByText(title, { exact: true }).first()

    await expect(painted).toBeVisible()
    const box = await painted.boundingBox()
    expect(box!.height, 'the painted title is the artwork and must be large').toBeGreaterThan(12)
  })
})
