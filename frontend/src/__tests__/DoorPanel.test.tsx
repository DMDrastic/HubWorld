/**
 * The door screen follows how the event lets people in.
 *
 * Until now nothing tested this panel at all. What matters here is the choice it
 * puts in front of door staff: an event that checks by signature offers
 * "Check someone in" (and creates a Xaman payload per guest); an event that
 * checks by code offers "Scan tickets" and creates none.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DoorPanel } from '@/components/DoorPanel'

vi.mock('@/components/DoorScanner', () => ({ default: () => <div data-testid="camera" /> }))

function mockApi(
  doorMode: 'QR' | 'SIGNATURE' | undefined,
  opts: { organizer?: boolean; doorCodes?: boolean } = {},
) {
  const { organizer = true, doorCodes = true } = opts
  const posts: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/door/events')) return json({ events: [{ slug: 'neon', title: 'Neon Night', via: organizer ? 'organizer' : 'staff', ...(doorMode ? { doorMode } : {}) }] })
      if (url.endsWith('/events/neon/door')) return json({ event: { slug: 'neon', title: 'Neon Night' }, admitted: 3, issued: 10, recent: [] })
      if (url.endsWith('/events/neon/staff')) return organizer ? json({ staff: [] }) : json({ error: 'Only the organizer' }, 403)
      if (url.endsWith('/policy')) return json({ platformBps: 250, maxRoyaltyBps: 2000, doorCodes })
      if (url.endsWith('/events/neon/door-mode') && method === 'POST') {
        const mode = JSON.parse(String(init?.body)).mode
        posts.push(`door-mode:${mode}`)
        return json({ slug: 'neon', doorMode: mode })
      }
      if (method === 'POST') {
        posts.push(url)
        return json({ checkInId: 'c', uuid: 'u', next: 'n', qrPng: 'data:image/png;base64,AA', expiresAt: new Date().toISOString(), mode: 'stub', event: { slug: 'neon', title: 'Neon Night' } }, 201)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return posts
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const renderPanel = () =>
  render(
    <StrictMode>
      <DoorPanel />
    </StrictMode>,
  )

describe('DoorPanel by door mode', () => {
  it('offers "Scan tickets" at an event that checks by code, and opens the camera without creating a payload', async () => {
    const posts = mockApi('QR')
    renderPanel()

    ;(await screen.findByRole('button', { name: /scan tickets/i })).click()

    expect(await screen.findByTestId('camera')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /check someone in/i })).toBeNull()
    expect(posts).toHaveLength(0)
  })

  it('offers "Check someone in" at an event that checks by Xaman signature, as before (positive control)', async () => {
    const posts = mockApi('SIGNATURE')
    renderPanel()

    ;(await screen.findByRole('button', { name: /check someone in/i })).click()

    expect(await screen.findByAltText(/check-in qr code/i)).toBeTruthy()
    expect(posts.some((u) => u.endsWith('/events/neon/checkin'))).toBe(true)
    expect(screen.queryByRole('button', { name: /scan tickets/i })).toBeNull()
  })

  it('treats a server that does not say as the signature flow', async () => {
    mockApi(undefined)
    renderPanel()

    expect(await screen.findByRole('button', { name: /check someone in/i })).toBeTruthy()
  })

  it('describes each mode in its own words', async () => {
    mockApi('QR')
    const { unmount } = renderPanel()
    expect(await screen.findByText(/screenshot won't get anyone in/i)).toBeTruthy()
    unmount()

    mockApi('SIGNATURE')
    renderPanel()
    expect(await screen.findByText(/a screenshot can't sign/i)).toBeTruthy()
  })

  it('shows how many are in', async () => {
    mockApi('QR')
    renderPanel()

    expect(await screen.findByText('3/10 in')).toBeTruthy()
  })

  describe('the organizer\'s switch', () => {
    it('lets the organizer change how guests get in, and the door follows at once', async () => {
      const posts = mockApi('QR')
      renderPanel()
      const select = (await screen.findByLabelText(/how guests get in/i)) as HTMLSelectElement
      expect(select.value).toBe('QR')
      expect(await screen.findByRole('button', { name: /scan tickets/i })).toBeTruthy()

      fireEvent.change(select, { target: { value: 'SIGNATURE' } })

      expect(await screen.findByRole('button', { name: /check someone in/i })).toBeTruthy()
      expect(posts).toContain('door-mode:SIGNATURE')
      expect(screen.queryByRole('button', { name: /scan tickets/i })).toBeNull()
    })

    it('is not shown to door staff, who may check people in and nothing else', async () => {
      mockApi('QR', { organizer: false })
      renderPanel()

      await screen.findByRole('button', { name: /scan tickets/i })
      expect(screen.queryByLabelText(/how guests get in/i)).toBeNull()
    })

    it('does not offer a code door the server cannot run, but still shows an event that has one', async () => {
      mockApi('SIGNATURE', { doorCodes: false })
      const { unmount } = renderPanel()
      await screen.findByRole('button', { name: /check someone in/i })
      // Nothing useful to switch to, so no switch.
      expect(screen.queryByLabelText(/how guests get in/i)).toBeNull()
      unmount()

      mockApi('QR', { doorCodes: false })
      renderPanel()
      const select = await screen.findByLabelText(/how guests get in/i)
      const qr = select.querySelector('option[value="QR"]') as HTMLOptionElement
      expect(qr.disabled).toBe(true)
    })
  })
})
