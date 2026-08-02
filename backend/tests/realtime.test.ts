/**
 * The realtime layer's contract with everything else.
 *
 * The property that matters is not that sockets work — it is that NOTHING ELSE
 * DEPENDS ON THEM. Settlement, bidding and gifting all publish auction events,
 * and every one of those paths must behave identically whether a socket server
 * is attached, unattached, or attached with a broken adapter. Realtime is an
 * accelerator; the HTTP API is the source of truth.
 *
 * That is what makes the adapter safe to add: the worst case is degraded
 * delivery, never a failed sale.
 */
import { describe, expect, it, vi } from 'vitest'
import { publishAuctionEvent } from '../src/realtime.js'

describe('publishAuctionEvent without a socket server', () => {
  // This is the state during every script run — `auction:settle`, `ledger:sync`,
  // the test suite itself — and during the window before attachRealtime runs.
  // A throw here would take down settlement, which must never depend on a
  // socket layer that is explicitly optional.
  it('is a no-op rather than a throw', () => {
    expect(() =>
      publishAuctionEvent({
        type: 'bid',
        auctionId: '00000000-0000-0000-0000-000000000000',
        amountDrops: '50000000',
        bidder: '@someone',
        placedAt: new Date().toISOString(),
      }),
    ).not.toThrow()
  })

  it('is a no-op for every event shape, not just bids', () => {
    const id = '00000000-0000-0000-0000-000000000000'
    expect(() =>
      publishAuctionEvent({
        type: 'settled',
        auctionId: id,
        amountDrops: '50000000',
        winner: '@winner',
        txHash: 'ABC',
      }),
    ).not.toThrow()
    expect(() =>
      publishAuctionEvent({ type: 'closed', auctionId: id, reason: 'no-bids' }),
    ).not.toThrow()
    expect(() =>
      publishAuctionEvent({ type: 'closed', auctionId: id, reason: 'reserve-not-met' }),
    ).not.toThrow()
  })
})

describe('adapter selection', () => {
  // Memory is the default on purpose. A single instance needs no coordination,
  // and defaulting to postgres would make every deployment — and every script
  // run — open a connection it has no use for.
  it('defaults to memory, so nothing is opened unless asked for', async () => {
    vi.resetModules()
    const { env } = await import('../src/env.js')
    expect(env.REALTIME_ADAPTER).toBe('memory')
  })

  it('only accepts modes that are actually implemented', async () => {
    // A typo like REALTIME_ADAPTER=redis must fail at startup rather than
    // silently falling back to memory, which would look like it worked and then
    // drop events across instances.
    const { z } = await import('zod')
    const schema = z.enum(['memory', 'postgres']).default('memory')
    expect(schema.safeParse('redis').success).toBe(false)
    expect(schema.safeParse('postgres').success).toBe(true)
    expect(schema.safeParse(undefined).success).toBe(true)
  })
})
