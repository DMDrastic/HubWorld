/**
 * The one property about an event row that jsdom structurally cannot check:
 * that its title is a real, VISIBLE heading, shown exactly once.
 *
 * The unit tests count headings and text nodes, which proves the title is in the
 * document once. They cannot see whether it is on screen. jsdom loads no
 * stylesheet, so a title hidden with `display: none`, or collapsed to a 1px box,
 * is indistinguishable from one a person can read. A real browser resolves the
 * CSS, so both failures become checkable here:
 *
 *   - `display: none`  -> Playwright's role engine will not match the heading.
 *   - a clipped title  -> the heading has no real box.
 *
 * It replaces a spec that guarded the opposite arrangement. The old poster
 * painted its title as `aria-hidden` artwork and kept a separate `sr-only`
 * heading for screen readers, so the thing to prove was that the heading was NOT
 * shown. A row has no painted copy, so the heading is the title: it must be shown.
 */
import { test, expect, type Page } from '@playwright/test'

type EventSummary = { title: string; imageUrl: string | null }

/**
 * An event with no artwork, taken from the running stack rather than fabricated.
 *
 * Without artwork is the harder case: the thumbnail is a coloured date tile, so
 * nothing else on the row could be mistaken for the name. Failing with the
 * command to run beats skipping, because a skipped test cannot fail.
 */
async function anEventWithoutArtwork(page: Page): Promise<string> {
  const res = await page.request.get('/api/events')
  expect(res.ok(), 'GET /api/events must answer before this can assert anything').toBeTruthy()

  const { events } = (await res.json()) as { events: EventSummary[] }
  const bare = events.find((e) => !e.imageUrl)

  expect(
    bare,
    'No event without artwork in the dev database. Run `npm run demo:seed` in backend/.',
  ).toBeTruthy()

  return bare!.title
}

/** The page opens on whichever of Upcoming and Past has events, so look in both. */
async function showEvent(page: Page, title: string) {
  await page.goto('/events')
  const heading = page.getByRole('heading', { name: title, exact: true })
  for (const view of ['Upcoming', 'Past']) {
    await page.getByRole('tab', { name: view }).click()
    if (await heading.first().isVisible()) return heading
  }
  return heading
}

test.describe('an event row names its event on screen', () => {
  test('the title is a real, visible heading', async ({ page }) => {
    const title = await anEventWithoutArtwork(page)
    const heading = await showEvent(page, title)

    await expect(
      heading.first(),
      'The title must be a heading a person and a screen reader can both reach. ' +
        'If it resolves to nothing it has been hidden with display:none.',
    ).toBeVisible()

    const box = await heading.first().boundingBox()
    expect(box, 'the heading must exist to be measured').not.toBeNull()
    expect(box!.height, 'the title is the row’s headline and must be large').toBeGreaterThan(12)
  })

  test('and it appears once, not once as text and again as a second heading', async ({ page }) => {
    const title = await anEventWithoutArtwork(page)
    const heading = await showEvent(page, title)

    await expect(heading).toHaveCount(1)
  })
})
