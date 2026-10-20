/**
 * What staff see while a camera streams codes at the door.
 *
 * A camera reports the same code several times a second, so the interesting
 * behaviour is in what is NOT done: a repeat is not a second person, two codes
 * in frame do not cross, a poster is not sent to the server, and a verdict does
 * not linger to be mistaken for the next guest's. The camera itself is replaced
 * by a stand-in that lets a test "see" a code.
 */
import { StrictMode } from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DoorCodeScan } from '@/components/DoorCodeScan'

const seen = vi.hoisted(() => ({ props: null as null | { onCode: (t: string) => void; paused?: boolean } }))
vi.mock('@/components/DoorScanner', () => ({
  default: (props: { onCode: (t: string) => void; paused?: boolean }) => {
    seen.props = props
    return <div data-testid="scanner" data-paused={String(!!props.paused)} />
  },
}))

type Verdict = { state: string; reason?: string; holder?: string | null; ticket?: unknown }
let posts: string[] = []
let reply: (n: number) => Verdict | 'fail' = () => ({ state: 'redeemed', holder: '@guest' })
let delayMs = 0

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  posts = []
  reply = () => ({ state: 'redeemed', holder: '@guest' })
  delayMs = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.includes('/checkin/scan')) throw new Error(`unexpected fetch: ${url}`)
      posts.push(JSON.parse(String(init?.body)).token)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      const r = reply(posts.length)
      if (r === 'fail') return new Response(JSON.stringify({ error: 'Not on the door for this event' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ checkInId: 'c1', holder: null, ticket: null, ...r }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const renderScan = (onAdmitted = vi.fn(), onDone = vi.fn()) =>
  render(
    <StrictMode>
      <DoorCodeScan slug="neon" onDone={onDone} onAdmitted={onAdmitted} />
    </StrictMode>,
  )
const see = async (code: string) => {
  await act(async () => {
    seen.props!.onCode(code)
  })
}

describe('DoorCodeScan', () => {
  it('shows ready, then a loud verdict for a scanned code, and refreshes the door count on admission', async () => {
    const onAdmitted = vi.fn()
    renderScan(onAdmitted)
    expect(await screen.findByText(/ready\. point the camera/i)).toBeTruthy()

    await see('HWD1.abc.def')

    expect(await screen.findByText('Admitted')).toBeTruthy()
    expect(screen.getByText('@guest')).toBeTruthy()
    expect(posts).toEqual(['HWD1.abc.def'])
    expect(onAdmitted).toHaveBeenCalledTimes(1)
  })

  it('says "Already checked in" in words, and does not count it as an admission', async () => {
    reply = () => ({ state: 'already_used', reason: 'That ticket has already been checked in' })
    const onAdmitted = vi.fn()
    renderScan(onAdmitted)
    await screen.findByTestId('scanner')

    await see('HWD1.abc.def')

    expect(await screen.findByText('Already checked in')).toBeTruthy()
    expect(onAdmitted).not.toHaveBeenCalled()
  })

  it('treats the same code seen again as the same person, not a second scan', async () => {
    renderScan()
    await screen.findByTestId('scanner')

    await see('HWD1.abc.def')
    await see('HWD1.abc.def')
    await see('HWD1.abc.def')

    expect(posts).toHaveLength(1)
  })

  it('accepts the same code again once it has been away long enough (positive control for the above)', async () => {
    renderScan()
    await screen.findByTestId('scanner')

    await see('HWD1.abc.def')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000)
    })
    await see('HWD1.abc.def')

    expect(posts).toHaveLength(2)
  })

  it('looks at one code at a time: a second in frame while one is being checked is ignored', async () => {
    delayMs = 500
    renderScan()
    await screen.findByTestId('scanner')

    await see('HWD1.first.code')
    await see('HWD1.second.code')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })

    expect(posts).toEqual(['HWD1.first.code'])
  })

  it('tells the camera to pause while a code is being checked', async () => {
    delayMs = 500
    renderScan()
    await screen.findByTestId('scanner')

    await see('HWD1.first.code')

    expect(screen.getByTestId('scanner').getAttribute('data-paused')).toBe('true')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(screen.getByTestId('scanner').getAttribute('data-paused')).toBe('false')
  })

  it('does not send a poster or a menu to the server, and says it is not a ticket', async () => {
    renderScan()
    await screen.findByTestId('scanner')

    await see('https://example.com/menu')

    expect(await screen.findByText(/not a hubworld ticket code/i)).toBeTruthy()
    expect(posts).toHaveLength(0)
  })

  it('takes a verdict off the screen after a few seconds, so it cannot be read as the next guest\'s', async () => {
    renderScan()
    await screen.findByTestId('scanner')
    await see('HWD1.abc.def')
    expect(await screen.findByText('Admitted')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_500)
    })

    expect(screen.queryByText('Admitted')).toBeNull()
    expect(screen.getByText(/ready\. point the camera/i)).toBeTruthy()
  })

  it('shows a failed check as a failure, never as the last guest\'s verdict', async () => {
    renderScan()
    await screen.findByTestId('scanner')
    await see('HWD1.good.one')
    expect(await screen.findByText('Admitted')).toBeTruthy()

    reply = () => 'fail'
    await see('HWD1.next.guest')

    expect(await screen.findByText(/not on the door for this event/i)).toBeTruthy()
    expect(screen.queryByText('Admitted')).toBeNull()
  })

  it('hands back control when staff press Done', async () => {
    const onDone = vi.fn()
    renderScan(vi.fn(), onDone)
    ;(await screen.findByRole('button', { name: /done/i })).click()

    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
