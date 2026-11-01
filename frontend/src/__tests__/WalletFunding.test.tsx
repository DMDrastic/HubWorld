/**
 * "Your wallet needs XRP": what a person sees when a purchase cannot go ahead because their wallet is empty. Written before the code.
 *
 * It names the address (so they can fund it), says how much and how much they have, and on TESTNET ONLY offers free test XRP.
 * On mainnet there is no button, because there is nothing to press: they have to send real XRP. Whether the faucet is
 * offered comes from the server's own answer, never from this page's guess.
 */
import { StrictMode } from 'react'
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

/** What GET /wallet/status says: a balance once the account exists on the ledger. */
const status = (balanceDrops?: string) => ({
  address: 'rWalletToFund00000000000000000',
  network: 'testnet',
  exists: balanceDrops !== undefined,
  ...(balanceDrops ? { balanceDrops, spendableDrops: balanceDrops } : {}),
  activationDrops: '1000000',
  canFund: true,
  signer: 'PRIVY',
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
  it('offers free test XRP, asks the SERVER for it, and lets them go on only once it has ARRIVED', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls: string[] = []
    let arrived = false
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${u}`)
      if (u.endsWith('/wallet/fund')) return json({ ok: true, amountXrp: 100 })
      return json(status(arrived ? '100000000' : undefined))
    }))
    const onRetry = vi.fn()
    render(<StrictMode><WalletFunding info={info()} onRetry={onRetry} /></StrictMode>)

    fireEvent.click(screen.getByRole('button', { name: /get test xrp/i }))
    expect(await screen.findByText(/100 test XRP is on its way/i)).toBeTruthy()
    // The request names no address: the server uses the signed-in wallet's own.
    expect(calls[0]).toBe('POST /api/wallet/fund')
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body).toBeUndefined()

    // Not yet on the ledger: going on now would find 0 XRP and send them back to the faucet button.
    const retry = screen.getByRole('button', { name: /waiting for it to arrive/i })
    expect((retry as HTMLButtonElement).disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onRetry).not.toHaveBeenCalled()

    arrived = true
    await vi.advanceTimersByTimeAsync(2_500)
    const go = await screen.findByRole('button', { name: /^continue$/i }, { timeout: 5_000 })
    expect(screen.getByText(/it has arrived/i)).toBeTruthy()
    fireEvent.click(go)
    expect(onRetry).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('checks every two seconds, counted, and stops checking once it has arrived', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let checks = 0
    let arrived = false
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.endsWith('/wallet/fund')) return json({ ok: true, amountXrp: 100 })
      checks += 1
      return json(status(arrived ? '100000000' : undefined))
    }))
    render(<StrictMode><WalletFunding info={info()} onRetry={vi.fn()} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: /get test xrp/i }))
    await screen.findByText(/on its way/i)

    await vi.advanceTimersByTimeAsync(10_000)
    // About five in ten seconds. A loop keyed on its own answers would fire one per round trip.
    expect(checks).toBeGreaterThanOrEqual(4)
    expect(checks).toBeLessThanOrEqual(7)

    arrived = true
    await vi.advanceTimersByTimeAsync(2_500)
    await screen.findByRole('button', { name: /^continue$/i }, { timeout: 5_000 })
    const settled = checks
    await vi.advanceTimersByTimeAsync(10_000)
    expect(checks).toBe(settled)
    vi.useRealTimers()
  })

  it('an unreadable ledger is not "arrived", and after a minute they may go on anyway, told why', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.endsWith('/wallet/fund')) return json({ ok: true, amountXrp: 100 })
      return json({ address: 'rWalletToFund00000000000000000', network: 'testnet', exists: null, activationDrops: '1000000', canFund: true, signer: 'PRIVY' })
    }))
    const onRetry = vi.fn()
    render(<StrictMode><WalletFunding info={info()} onRetry={onRetry} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: /get test xrp/i }))
    await screen.findByText(/on its way/i)
    await vi.advanceTimersByTimeAsync(30_000)
    expect((screen.getByRole('button', { name: /waiting for it to arrive/i }) as HTMLButtonElement).disabled).toBe(true)

    await vi.advanceTimersByTimeAsync(31_000)
    expect(await screen.findByText(/has not shown up yet/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    // And the faucet button is not offered again: pressing it would spend another of the day's three.
    expect(screen.queryByRole('button', { name: /get test xrp/i })).toBeNull()
    vi.useRealTimers()
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
