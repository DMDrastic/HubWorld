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
import { render, screen } from '@testing-library/react'
import { DoorPanel } from '@/components/DoorPanel'

vi.mock('@/components/DoorScanner', () => ({ default: () => <div data-testid="camera" /> }))

function mockApi(doorMode: 'QR' | 'SIGNATURE' | undefined) {
  const posts: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/door/events')) return json({ events: [{ slug: 'neon', title: 'Neon Night', via: 'organizer', ...(doorMode ? { doorMode } : {}) }] })
      if (url.endsWith('/events/neon/door')) return json({ event: { slug: 'neon', title: 'Neon Night' }, admitted: 3, issued: 10, recent: [] })
      if (url.endsWith('/events/neon/staff')) return json({ staff: [] })
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
})
