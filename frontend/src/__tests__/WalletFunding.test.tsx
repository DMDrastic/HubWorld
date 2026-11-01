/**
 * "Your wallet needs XRP": what a person sees when a purchase cannot go ahead because their wallet is empty. Written before the code.
 *
 * It names the address (so they can fund it), says how much and how much they have, and on TESTNET ONLY offers free test XRP.
 * On mainnet there is no button, because there is nothing to press: they have to send real XRP. Whether the faucet is
 * offered comes from the server's own answer, never from this page's guess.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WalletFunding } from '@/components/WalletFunding'
import { json } from './fakeRuntime'

const info = (over: Record<string, unknown> = {}) => ({
  address: 'rWalletToFund00000000000000000',
  network: 'testnet',
  neededDrops: '27175000',
  haveDrops: '0',
  canFund: true,
  ...over,
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what it tells the person', () => {
  it('names the wallet, how much it needs, and how much it has', () => {
    render(<WalletFunding info={info({ haveDrops: '5000000' })} onRetry={vi.fn()} />)
    expect(screen.getByText('rWalletToFund00000000000000000')).toBeTruthy()
    expect(screen.getByText(/needs about 27\.175 XRP/i)).toBeTruthy()
    expect(screen.getByText(/has 5 XRP/i)).toBeTruthy()
  })

  it('says an empty wallet has nothing, rather than showing zero as if it were a balance', () => {
    render(<WalletFunding info={info()} onRetry={vi.fn()} />)
    expect(screen.getByText(/has 0 XRP/i)).toBeTruthy()
  })

  it('lets them copy the address', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<WalletFunding info={info()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /copy address/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('rWalletToFund00000000000000000'))
  })
})

describe('on the test network', () => {
  it('offers free test XRP, asks the SERVER for it, and then lets them try again', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${u}`)
      return json({ ok: true, amountXrp: 100 })
    }))
    const onRetry = vi.fn()
    render(<WalletFunding info={info()} onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button', { name: /get test xrp/i }))
    expect(await screen.findByText(/100 test XRP is on its way/i)).toBeTruthy()
    // The request names no address: the server uses the signed-in wallet's own.
    expect(calls).toEqual(['POST /api/wallet/fund'])
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows the server’s own words when the faucet refuses (the daily limit)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'FAUCET_LIMIT', error: 'You can request test XRP 3 times a day. Try again tomorrow.' }, 429)))
    render(<WalletFunding info={info()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /get test xrp/i }))
    expect(await screen.findByText(/3 times a day/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /get test xrp/i })).toBeTruthy() // can be pressed again
  })

  it('cannot be pressed twice at once', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const f = vi.fn(async () => { await gate; return json({ ok: true, amountXrp: 100 }) })
    vi.stubGlobal('fetch', f)
    render(<WalletFunding info={info()} onRetry={vi.fn()} />)
    const button = screen.getByRole('button', { name: /get test xrp/i })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(f).toHaveBeenCalledTimes(1)
    release()
    await screen.findByText(/on its way/i)
  })
})

describe('on mainnet (the server says there is no faucet)', () => {
  it('shows the address and the amount, offers NO faucet button, and says plainly what to do', () => {
    render(<WalletFunding info={info({ network: 'mainnet', canFund: false })} onRetry={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /get test xrp/i })).toBeNull()
    expect(screen.getByText(/send at least 27\.175 XRP to this address/i)).toBeTruthy()
    expect(screen.getByText('rWalletToFund00000000000000000')).toBeTruthy()
    expect(screen.getByRole('button', { name: /i.ve sent it|check again/i })).toBeTruthy()
  })

  it('decides from the SERVER’s canFund, not from the network name alone', () => {
    render(<WalletFunding info={info({ network: 'testnet', canFund: false })} onRetry={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /get test xrp/i })).toBeNull()
  })

  it('"check again" lets them retry the purchase once the XRP has arrived', () => {
    const onRetry = vi.fn()
    render(<WalletFunding info={info({ network: 'mainnet', canFund: false })} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: /check again|i.ve sent it/i }))
    expect(onRetry).toHaveBeenCalled()
  })
})
