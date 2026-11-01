/**
 * The resale policy choices when creating an event.
 *
 * Under the new fee model a ticket can never be resold for more than its buyer paid, so a policy that allows
 * more (unrestricted, a percentage above 100%, a fixed cap above the price) promises the organizer something
 * that will not happen. The server says whether those choices are offered; this pins that the form hides them,
 * says why, sends what was chosen, and is unchanged where the server still offers everything.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OrganizerPanel } from '@/components/OrganizerPanel'

function mockApi(policy: object) {
  const created: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/policy')) return json({ platformBps: 250, maxRoyaltyBps: 2000, ...policy })
      if (url.endsWith('/organizers/me')) return json({ role: 'ORGANIZER', application: null })
      if (url.endsWith('/events') && method === 'POST') {
        created.push(JSON.parse(String(init?.body)))
        return json({ slug: 'neon', title: 'Neon Night', startsAt: new Date().toISOString(), ticketCount: 100, royaltyBps: 500, platformBps: 250, nftTaxon: 1001, resalePolicy: 'FACE_VALUE_ONLY', doorMode: 'SIGNATURE' }, 201)
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

const optionValues = (select: HTMLSelectElement) => [...select.options].map((o) => o.value)

describe('where the server still offers every resale policy', () => {
  for (const [label, policy] of [['looseResalePolicies true', { looseResalePolicies: true }], ['an older server that says nothing', {}]] as const) {
    it(`shows all five and defaults to unrestricted (${label})`, async () => {
      mockApi(policy)
      renderPanel()
      const select = (await screen.findByLabelText('resale policy')) as HTMLSelectElement
      await waitFor(() => expect(optionValues(select)).toContain('UNRESTRICTED'))
      expect(optionValues(select)).toEqual(['UNRESTRICTED', 'PERCENTAGE_CAP', 'FIXED_CAP', 'FACE_VALUE_ONLY', 'DISABLED'])
      expect(select.value).toBe('UNRESTRICTED')
      expect(screen.queryByText(/capped at what the buyer paid/i)).toBeNull()
    })
  }
})

describe('where the server has turned the loose policies off', () => {
  const OFF = { feeModel: 'v2', looseResalePolicies: false }

  it('hides unrestricted, keeps the rest, defaults to face value only, and says why', async () => {
    mockApi(OFF)
    renderPanel()
    const select = (await screen.findByLabelText('resale policy')) as HTMLSelectElement
    await waitFor(() => expect(optionValues(select)).not.toContain('UNRESTRICTED'))
    expect(optionValues(select)).toEqual(['PERCENTAGE_CAP', 'FIXED_CAP', 'FACE_VALUE_ONLY', 'DISABLED'])
    expect(select.value).toBe('FACE_VALUE_ONLY')
    expect(screen.getByText(/resale is capped at what the buyer paid/i)).toBeTruthy()
  })

  it('sends face value only when the organizer changes nothing', async () => {
    const created = mockApi(OFF)
    renderPanel()
    await waitFor(async () => expect(optionValues((await screen.findByLabelText('resale policy')) as HTMLSelectElement)).not.toContain('UNRESTRICTED'))
    await fillAndCreate()
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ resalePolicy: 'FACE_VALUE_ONLY' })
  })

  it('refuses a percentage cap above 100% in the form, without sending it, and sends 100%', async () => {
    const created = mockApi(OFF)
    renderPanel()
    const select = (await screen.findByLabelText('resale policy')) as HTMLSelectElement
    await waitFor(() => expect(optionValues(select)).not.toContain('UNRESTRICTED'))
    fireEvent.change(select, { target: { value: 'PERCENTAGE_CAP' } })
    fireEvent.change(screen.getByLabelText('resale cap percent of face value'), { target: { value: '120' } })
    await fillAndCreate()
    expect(await screen.findByText(/100%/)).toBeTruthy()
    expect(created).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('resale cap percent of face value'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: /create event/i }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ resalePolicy: 'PERCENTAGE_CAP', resaleCapBps: 10_000 })
  })

  it('offers a fixed cap (in XRP until resale moves to US$) only for an event with no US$ box-office price', async () => {
    const created = mockApi(OFF)
    renderPanel()
    const select = (await screen.findByLabelText('resale policy')) as HTMLSelectElement
    await waitFor(() => expect(optionValues(select)).not.toContain('UNRESTRICTED'))
    fireEvent.change(select, { target: { value: 'FIXED_CAP' } })
    fireEvent.change(screen.getByLabelText('resale cap in XRP'), { target: { value: '25' } })
    await fillAndCreate()
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ resalePolicy: 'FIXED_CAP', resaleCapDrops: '25000000' })
    expect(created[0]).not.toHaveProperty('primaryPriceUsdCents')

    // With a price, the option goes, and a cap already chosen falls back to face value only.
    fireEvent.change(screen.getByLabelText(/ticket price/i), { target: { value: '20' } })
    expect(optionValues(select)).not.toContain('FIXED_CAP')
    expect(select.value).toBe('FACE_VALUE_ONLY')
  })
})
