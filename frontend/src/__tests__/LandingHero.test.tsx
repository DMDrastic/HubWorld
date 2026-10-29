/**
 * The landing page's two honest-content features.
 *
 * The poster cloud shows REAL events and nothing else: with none there is no cloud,
 * and no poster is ever invented to fill the space. The create demo's colour is READ
 * from the poster the visitor picks, through the same code the real create page
 * uses, and it is labelled as an example because it is one.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Landing } from '@/components/Landing'
import { LandingCreateDemo } from '@/components/LandingCreateDemo'
import { LandingPosterCloud } from '@/components/LandingPosterCloud'
import { pickCloudEvents } from '@/lib/landing-events'
import type { EventSummary } from '@/lib/api'

const day = 86_400_000
function event(slug: string, over: Partial<EventSummary> = {}): EventSummary {
  return {
    slug,
    title: `Event ${slug}`,
    venue: null,
    startsAt: new Date(Date.now() + 3 * day).toISOString(),
    imageUrl: null,
    status: 'PUBLISHED',
    ticketCount: 10,
    ticketsMinted: 10,
    organizer: { username: 'o', displayName: null },
    ...over,
  }
}

/** An event with a poster: the only kind the cloud shows. */
const withArt = (slug: string, over: Partial<EventSummary> = {}) =>
  event(slug, { imageUrl: `https://example.test/${slug}.jpg`, ...over })

describe('which events float around the headline', () => {
  it('shows only published and sold-out events, never a draft, a cancelled or a finished one', () => {
    const picked = pickCloudEvents([
      withArt('ok'),
      withArt('sold', { status: 'SOLD_OUT' }),
      withArt('draft', { status: 'DRAFT' }),
      withArt('off', { status: 'CANCELLED' }),
      withArt('done', { status: 'COMPLETED' }),
    ])
    expect(picked.map((e) => e.slug).sort()).toEqual(['ok', 'sold'])
  })

  it('leaves out an event with no poster, which would only be a flat tile among real artwork', () => {
    const picked = pickCloudEvents([event('bare'), withArt('art')])
    expect(picked.map((e) => e.slug)).toEqual(['art'])
  })

  it('puts upcoming events ahead of past ones, then the soonest', () => {
    const picked = pickCloudEvents([
      withArt('later', { startsAt: new Date(Date.now() + 9 * day).toISOString() }),
      withArt('past', { startsAt: new Date(Date.now() - 30 * day).toISOString() }),
      withArt('soon', { startsAt: new Date(Date.now() + 1 * day).toISOString() }),
    ])
    expect(picked.map((e) => e.slug)).toEqual(['soon', 'later', 'past'])
  })

  it('never shows more than it has places for', () => {
    const many = Array.from({ length: 20 }, (_, i) => withArt(`e${i}`))
    expect(pickCloudEvents(many)).toHaveLength(8)
  })
})

describe('the poster cloud', () => {
  /** Every poster in the wide layout, which is the one that carries all eight. */
  const wide = (container: HTMLElement) => container.querySelectorAll('ul')[0]!.querySelectorAll('li')

  it('always has eight places, real events first and decorative artwork after', () => {
    const { container } = render(
      <LandingPosterCloud events={[withArt('a', { title: 'Late Set' }), withArt('b', { title: 'Block Party' })]} />,
    )
    const items = wide(container)
    expect(items).toHaveLength(8)
    // The first two are the real events, in links; the other six are not.
    expect(items[0]!.querySelector('a')).not.toBeNull()
    expect(items[1]!.querySelector('a')).not.toBeNull()
    for (let i = 2; i < 8; i++) expect(items[i]!.querySelector('a')).toBeNull()
  })

  it('shows artwork in every place, never a flat colour tile', () => {
    // The bug this pins: events with no poster used to take the first places as plain
    // date tiles, so a page with no uploaded posters looked like a row of broken images.
    const { container } = render(
      <LandingPosterCloud events={[event('no-art-1'), event('no-art-2'), withArt('real')]} />,
    )
    for (const li of wide(container)) {
      expect(li.querySelector('img')).not.toBeNull()
      expect(li.querySelector('[data-fallback]')).toBeNull()
    }
    // Only the one event that has a poster is linked.
    expect(container.querySelectorAll('ul')[0]!.querySelectorAll('a')).toHaveLength(1)
  })

  it('fills every place with decorative artwork when there are no events at all', () => {
    const { container } = render(<LandingPosterCloud events={[]} />)
    expect(wide(container)).toHaveLength(8)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('treats drafts and cancelled events as no events, so they never appear', () => {
    const { container } = render(
      <LandingPosterCloud events={[withArt('d', { status: 'DRAFT' }), withArt('c', { status: 'CANCELLED' })]} />,
    )
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('hides decoration from assistive technology and announces only real events', () => {
    const { container } = render(<LandingPosterCloud events={[withArt('a', { title: 'Late Set' })]} />)
    const items = wide(container)
    for (let i = 1; i < 8; i++) expect(items[i]!.getAttribute('aria-hidden')).toBe('true')
    expect(items[0]!.getAttribute('aria-hidden')).toBeNull()
    expect(container.querySelectorAll('ul')[0]!.getAttribute('aria-label')).toBe('Events on HubWorld')
  })

  it('announces nothing at all when the whole cloud is decoration', () => {
    // A list labelled "Events on HubWorld" with no event in it would be a lie, and
    // that includes a cloud whose only events had no poster to show.
    const { container } = render(<LandingPosterCloud events={[event('bare')]} />)
    const list = container.querySelectorAll('ul')[0]!
    expect(list.getAttribute('aria-hidden')).toBe('true')
    expect(list.getAttribute('aria-label')).toBeNull()
  })

  it('gives the decorative posters no title, date or text of any kind', () => {
    const { container } = render(<LandingPosterCloud events={[]} />)
    expect(container.textContent).toBe('')
  })

  it('names each real poster by its event, as a link to the Events page', () => {
    render(<LandingPosterCloud events={[withArt('a', { title: 'Neon Rooftop' })]} />)
    // Both the wide and the narrow layouts render, so the link appears in each.
    const links = screen.getAllByRole('link', { name: 'Neon Rooftop' })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link.getAttribute('href')).toBe('/events')
  })

  it('shows the event\'s own poster image', () => {
    const { container } = render(
      <LandingPosterCloud events={[withArt('a', { imageUrl: 'https://example.test/p.jpg' })]} />,
    )
    expect(wide(container)[0]!.querySelector('a img')?.getAttribute('src')).toBe('https://example.test/p.jpg')
  })
})

describe('the poster float', () => {
  it('keeps each poster tilt on the outer element and puts the drift on a wrapper inside it', () => {
    // If the drift shared the tilted element it would overwrite the tilt, and every
    // poster would snap upright. They are separate on purpose.
    const { container } = render(<LandingPosterCloud events={[]} />)
    for (const li of container.querySelectorAll('ul')[0]!.querySelectorAll('li')) {
      expect((li as HTMLElement).style.transform).toMatch(/rotate\(-?\d+deg\)/)
      const drift = li.querySelector('.float-y') as HTMLElement
      expect(drift).not.toBeNull()
      expect(drift.style.transform).toBe('')
    }
  })

  it('gives the posters different rhythms, so none rises with another', () => {
    const { container } = render(<LandingPosterCloud events={[]} />)
    const timings = [...container.querySelectorAll('ul')[0]!.querySelectorAll('.float-y')].map(
      (el) => `${(el as HTMLElement).style.getPropertyValue('--float-duration')}|${(el as HTMLElement).style.animationDelay}`,
    )
    expect(new Set(timings).size).toBe(timings.length)
  })

  it('returns to rest at the end of every cycle, so reduced motion leaves them in place', () => {
    // Reduced motion collapses an animation to a single near-instant pass, which lands
    // on the LAST keyframe. That must be the resting position, not mid-drift.
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const block = /@keyframes float-y\s*\{([\s\S]*?)\n\s{4}\}\n/.exec(css)![1]!
    expect(block).toMatch(/0%,\s*100%\s*\{\s*transform: translateY\(0\)/)
  })

  it('moves vertically only, never touching the tilt, position or size', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const block = /@keyframes float-y\s*\{([\s\S]*?)\n\s{4}\}\n/.exec(css)![1]!
    expect(block).not.toMatch(/rotate|scale|translateX|left|right/)
  })
})

describe('the landing headline', () => {
  it('is one h1, in the owner\'s own words, with only the closing phrase picked out', () => {
    const { container } = render(<Landing onAuthenticated={vi.fn()} events={[]} />)
    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)
    // The gradient is paint; the words must read as one sentence to a screen reader.
    expect(h1[0]!.textContent).toBe('Every ticket you hold, in one hub.')
    const picked = h1[0]!.querySelector('.warm-text')
    expect(picked?.textContent).toBe('in one hub.')
    // Used once on the whole page, never as a recurring device.
    expect(container.querySelectorAll('.warm-text')).toHaveLength(1)
  })

  it('keeps the owner\'s supporting line and adds the royalty hook to it', () => {
    render(<Landing onAuthenticated={vi.fn()} events={[]} />)
    const line = screen.getByText(/Buy, gift, resell and check in/)
    expect(line.textContent).toBe(
      'Buy, gift, resell and check in — all from one place, while organizers stay connected to what happens after the first sale, and earn a royalty on every resale.',
    )
    expect(screen.getByText('earn a royalty on every resale')).toBeTruthy()
  })

  it('shows the real events it was given, where they have a poster', () => {
    render(<Landing onAuthenticated={vi.fn()} events={[withArt('a', { title: 'Late Set' })]} />)
    expect(screen.getAllByRole('link', { name: 'Late Set' }).length).toBeGreaterThan(0)
  })

  it('renders without error, and with decoration only, when no events were passed', () => {
    render(<Landing onAuthenticated={vi.fn()} />)
    expect(screen.queryByLabelText('Events on HubWorld')).toBeNull()
  })
})

describe('the warm gradient', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
  const stops = (scope: RegExp) => {
    const block = scope.exec(css)![1]!
    return [/--warm-a:\s*(#[0-9a-f]{6})/i.exec(block)![1]!, /--warm-b:\s*(#[0-9a-f]{6})/i.exec(block)![1]!]
  }
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const luminance = (hex: string) => {
    const [r, g, b] = rgb(hex).map((v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi! + 0.05) / (lo! + 0.05)
  }
  // The light theme's stops are on the plain class; the dark ones are scoped under `.dark`.
  const light = stops(/\n\s*(\.warm-text \{[^}]*\})/)
  const dark = stops(/(\.dark \.warm-text \{[^}]*\})/)

  const hue = (hex: string) => {
    const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number]
    const max = Math.max(r, g, b)
    const d = max - Math.min(r, g, b)
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return (h * 60 + 360) % 360
  }

  it('runs between warm hues only, never through purple', () => {
    // The blend this project's rules single out is purple to pink or blue. Purple sits
    // between about 250 and 310 degrees on the colour wheel, so no stop may be near it:
    // raspberry (around 342) and amber (around 40) are both on the warm side, and the
    // short way between them runs through red and orange.
    for (const hex of [...light, ...dark]) {
      const h = hue(hex)
      expect(h < 60 || h > 330, `${hex} is at ${h.toFixed(0)} degrees`).toBe(true)
    }
  })

  it('keeps the thin parts of the letters at 3:1 or better on the page, in both themes', () => {
    // Large text needs 3:1. The backgrounds are the lightest and darkest the hero shows.
    for (const hex of light) expect(contrast(hex, '#e3e8ef'), hex).toBeGreaterThanOrEqual(3)
    for (const hex of dark) expect(contrast(hex, '#0e0e12'), hex).toBeGreaterThanOrEqual(3)
  })

  it('falls back to plain text where the gradient cannot be painted', () => {
    expect(css).toMatch(/@supports \(\(background-clip: text\)/)
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.warm-text \{[^}]*color: CanvasText/)
  })
})

describe('the create demo', () => {
  it('says it is an example', () => {
    render(<LandingCreateDemo readTint={async () => null} />)
    expect(screen.getByText(/example event/i)).toBeTruthy()
  })

  it('offers three sample posters as one radio group, with the first chosen', () => {
    render(<LandingCreateDemo readTint={async () => null} />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect((radios[0] as HTMLInputElement).checked).toBe(true)
  })

  it('swaps the poster when another is picked', () => {
    render(<LandingCreateDemo readTint={async () => null} />)
    const before = screen.getByAltText(/sample poster/i).getAttribute('src')
    fireEvent.click(screen.getAllByRole('radio')[2]!)
    expect(screen.getByAltText(/sample poster/i).getAttribute('src')).not.toBe(before)
  })

  it('reads the colour from the poster it is showing, not from a fixed value', async () => {
    const read = vi.fn(async (_url: string) => [255, 110, 0] as const)
    const { container } = render(<LandingCreateDemo readTint={read} />)
    await waitFor(() =>
      expect(container.querySelector('[data-demo-wash]')?.getAttribute('data-demo-wash')).toBe('on'),
    )
    const first = read.mock.calls[0]![0]
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1))
    // A different poster means a different image was handed to the reader.
    expect(read.mock.calls.at(-1)![0]).not.toBe(first)
  })

  it('stays neutral, and keeps working, where the colour cannot be read', async () => {
    const { container } = render(<LandingCreateDemo readTint={async () => null} />)
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    await waitFor(() => expect(container.querySelector('[data-demo-wash]')).not.toBeNull())
    expect(container.querySelector('[data-demo-wash]')?.getAttribute('data-demo-wash')).toBe('off')
    expect(screen.getByRole('link', { name: /create yours/i }).getAttribute('href')).toBe('#hero-signin')
  })
})
