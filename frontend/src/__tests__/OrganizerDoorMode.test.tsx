/**
 * Choosing how guests get in, when creating an event.
 *
 * The choice is offered only where the server can run it, so an organizer is never
 * handed a door their own server cannot operate, and what they choose is what is
 * sent: a form that showed the select but dropped the value would leave every
 * event on the server's default whatever the organizer picked.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OrganizerPanel } from '@/components/OrganizerPanel'

function mockApi(doorCodes: boolean | undefined) {
  const created: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/policy')) return json({ platformBps: 250, maxRoyaltyBps: 2000, ...(doorCodes === undefined ? {} : { doorCodes }) })
      if (url.endsWith('/organizers/me')) return json({ role: 'ORGANIZER', application: null })
      if (url.endsWith('/events') && method === 'POST') {
        created.push(JSON.parse(String(init?.body)))
        return json({ slug: 'neon', title: 'Neon Night', startsAt: new Date().toISOString(), ticketCount: 100, royaltyBps: 500, platformBps: 250, nftTaxon: 1001, resalePolicy: 'UNRESTRICTED', doorMode: 'QR' }, 201)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return created
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

describe('Creating an event: how guests get in', () => {
  it('offers the choice where the server can run the code door, defaulting to Xaman and saying why', async () => {
    mockApi(true)
    renderPanel()

    const select = (await screen.findByLabelText('how guests get in')) as HTMLSelectElement
    // The stricter door is the default: the faster one is something an organizer chooses.
    expect(select.value).toBe('SIGNATURE')
    expect(screen.getByText(/proves the guest's own wallet is at the door/i)).toBeTruthy()
    expect(screen.getByText(/you can change this later/i)).toBeTruthy()
  })

  it('sends what the organizer chose', async () => {
    const created = mockApi(true)
    renderPanel()
    fireEvent.change(await screen.findByLabelText('how guests get in'), { target: { value: 'QR' } })

    await fillAndCreate()

    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]!.doorMode).toBe('QR')
  })

  it('sends the default choice too, rather than leaving it to the server', async () => {
    const created = mockApi(true)
    renderPanel()
    await screen.findByLabelText('how guests get in')

    await fillAndCreate()

    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]!.doorMode).toBe('SIGNATURE')
  })

  it('does not offer it, and does not send it, where the server cannot run the code door', async () => {
    const created = mockApi(false)
    renderPanel()
    await screen.findByLabelText('event title')

    expect(screen.queryByLabelText('how guests get in')).toBeNull()
    await fillAndCreate()

    await waitFor(() => expect(created).toHaveLength(1))
    expect('doorMode' in created[0]!).toBe(false)
  })

  it('treats a server that does not say as one that cannot', async () => {
    mockApi(undefined)
    renderPanel()
    await screen.findByLabelText('event title')

    expect(screen.queryByLabelText('how guests get in')).toBeNull()
  })
})
