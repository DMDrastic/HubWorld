/**
 * The poster on the create-event page.
 *
 * The upload endpoint is keyed on the event's slug, which only exists once the
 * event has been created. So the composer holds the chosen file and sends it
 * AFTER the create succeeds, and the order is the property: an upload before the
 * create has no slug to go to, and an event that fails to create must not have
 * sent a poster for it.
 *
 * The second property is what a failed upload means. The event exists by then, so
 * the page must say the poster failed and NOT that the event did: reporting a
 * created event as a failure invites a second, duplicate create.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OrganizerPanel } from '@/components/OrganizerPanel'

type Call = { kind: 'create' | 'upload'; body?: unknown }

function mockApi(opts: { uploadStatus?: number } = {}) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/policy')) return json({ platformBps: 250, maxRoyaltyBps: 2000 })
      if (url.endsWith('/organizers/me')) return json({ role: 'ORGANIZER', application: null })
      if (url.endsWith('/events') && method === 'POST') {
        calls.push({ kind: 'create', body: JSON.parse(String(init?.body)) })
        return json(
          {
            slug: 'neon',
            title: 'Neon Night',
            startsAt: new Date().toISOString(),
            ticketCount: 100,
            royaltyBps: 500,
            platformBps: 250,
            nftTaxon: 1001,
            resalePolicy: 'UNRESTRICTED',
            resaleCapBps: null,
            resaleCapDrops: null,
            doorMode: 'SIGNATURE',
          },
          201,
        )
      }
      if (url.endsWith('/events/neon/image') && method === 'POST') {
        calls.push({ kind: 'upload', body: init?.body })
        return opts.uploadStatus && opts.uploadStatus >= 400
          ? json({ error: 'Image storage is not configured' }, opts.uploadStatus)
          : json({ slug: 'neon', imageUrl: 'https://example.test/neon.png' })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return calls
}

const png = (name = 'poster.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

beforeEach(() => {
  // jsdom has no object URLs; the preview only needs a string back.
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // The URL stubs are deliberately left in place: React's own cleanup runs after
  // this hook and revokes the preview, and a stub removed here would make that throw.
})

const renderPanel = () =>
  render(
    <StrictMode>
      <OrganizerPanel role="ORGANIZER" onChanged={vi.fn()} />
    </StrictMode>,
  )

async function fillAndCreate() {
  fireEvent.change(await screen.findByLabelText('event title'), { target: { value: 'Neon Night' } })
  fireEvent.change(screen.getByLabelText('starts at'), { target: { value: '2030-01-01T20:00' } })
  fireEvent.click(screen.getByRole('button', { name: /create event/i }))
}

describe('the poster on the create page', () => {
  it('previews the chosen poster straight away', async () => {
    mockApi()
    renderPanel()
    fireEvent.change(await screen.findByLabelText('poster image'), { target: { files: [png()] } })

    expect((await screen.findByAltText('Poster preview')).getAttribute('src')).toBe('blob:preview')
  })

  it('uploads it only AFTER the event has been created', async () => {
    const calls = mockApi()
    renderPanel()
    fireEvent.change(await screen.findByLabelText('poster image'), { target: { files: [png()] } })

    await fillAndCreate()

    await waitFor(() => expect(calls.map((c) => c.kind)).toEqual(['create', 'upload']))
    expect((calls[1]!.body as File).name).toBe('poster.png')
  })

  it('sends no upload at all when no poster was chosen', async () => {
    const calls = mockApi()
    renderPanel()

    await fillAndCreate()

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.kind).toBe('create')
  })

  it('refuses a file the server would refuse, and does not stage it', async () => {
    const calls = mockApi()
    renderPanel()
    const gif = new File(['x'], 'cat.gif', { type: 'image/gif' })
    fireEvent.change(await screen.findByLabelText('poster image'), { target: { files: [gif] } })

    expect(await screen.findByText(/choose a jpeg, png or webp/i)).toBeTruthy()
    expect(screen.queryByAltText('Poster preview')).toBeNull()

    await fillAndCreate()
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls.map((c) => c.kind)).toEqual(['create'])
  })

  it('lets the organizer take a staged poster back out', async () => {
    mockApi()
    renderPanel()
    fireEvent.change(await screen.findByLabelText('poster image'), { target: { files: [png()] } })
    await screen.findByAltText('Poster preview')

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.queryByAltText('Poster preview')).toBeNull()
  })

  it('says the POSTER failed, not the event, when the upload is refused', async () => {
    const calls = mockApi({ uploadStatus: 503 })
    renderPanel()
    fireEvent.change(await screen.findByLabelText('poster image'), { target: { files: [png()] } })

    await fillAndCreate()

    // The event was created, so it is reported as created.
    expect(await screen.findByText(/Neon Night/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/created/i)
    // And the poster failure is its own message, with where to retry it.
    expect(await screen.findByText(/poster could not be uploaded/i)).toBeTruthy()
    expect(screen.getByText(/event posters below/i)).toBeTruthy()
    // It must not be presented as an error that invites creating the event again.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls.filter((c) => c.kind === 'create')).toHaveLength(1)
  })
})

describe('what the composer does not pretend to offer', () => {
  it.each(['description', 'end', 'calendar', 'visibility', 'approval', 'theme'])(
    'has no %s control, because nothing behind it exists',
    async (word) => {
      mockApi()
      renderPanel()
      await screen.findByLabelText('event title')
      expect(screen.queryByLabelText(new RegExp(word, 'i'))).toBeNull()
    },
  )

  it('names the time zone the start time will be read in', async () => {
    mockApi()
    renderPanel()
    await screen.findByLabelText('event title')
    expect(screen.getByText(/^GMT[+-]\d{2}:\d{2}$/)).toBeTruthy()
  })
})
