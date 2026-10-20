/**
 * Telling housekeeping from an incident.
 *
 * An organizer's account holds offers the delegate made. Every one should match a
 * listing; the ones that do not split into "inert, tidy it up" and "someone may
 * be able to take a ticket". Collapsing those would either bury an incident in
 * noise or have a script cancel things that need a human.
 */
import { describe, expect, it } from 'vitest'
import { cancellableByBroker, findOrphanOffers, type LedgerOffer } from '../src/orphan-offers.js'

const BROKER = 'rBroker0000000000000000000000'
const ORGANIZER = 'rOrganizer0000000000000000000'
const OTHER = 'rSomeoneElse000000000000000000'

const offer = (over: Partial<LedgerOffer> = {}): LedgerOffer => ({
  index: 'AA'.repeat(32),
  nfTokenId: 'BB'.repeat(32),
  isSell: true,
  amount: '25000000',
  destination: BROKER,
  owner: ORGANIZER,
  ...over,
})

const find = (offers: LedgerOffer[], known: Array<[string, string]> = []) =>
  findOrphanOffers({
    offers,
    known: new Map(known.map(([k, status]) => [k, { status }])),
    brokerAddress: BROKER,
  })

describe('findOrphanOffers', () => {
  it('ignores an offer a live listing accounts for', () => {
    for (const status of ['ACTIVE', 'BUYER_PENDING', 'SETTLING', 'CANCELLING', 'PENDING_OFFER']) {
      expect(find([offer()], [['AA'.repeat(32), status]])).toEqual([])
    }
  })

  it('reports an offer with no listing at all as inert when only the broker can match it', () => {
    const [o] = find([offer()])
    expect(o).toMatchObject({ kind: 'inert' })
    expect(o!.why).toMatch(/broker-only/)
  })

  it('treats an OPEN sell offer as exposed — anyone could take the ticket', () => {
    const [o] = find([offer({ destination: null })])
    expect(o).toMatchObject({ kind: 'exposed' })
    expect(o!.why).toMatch(/open to anyone/)
  })

  it('treats a sell offer destined for someone else as exposed, and names them', () => {
    // The shape of a delegate made to give a ticket away.
    const [o] = find([offer({ destination: OTHER, amount: '0' })])
    expect(o).toMatchObject({ kind: 'exposed' })
    expect(o!.why).toContain(OTHER)
  })

  it('does not second-guess an offer a live listing claims', () => {
    // A live listing means we made it on purpose, so it is not an orphan. That an
    // expected offer names the broker is checkSellOffer's job, before signing.
    expect(find([offer({ destination: null })], [['AA'.repeat(32), 'ACTIVE']])).toEqual([])
  })

  it('reports an offer whose listing has finished as stale', () => {
    for (const status of ['SOLD', 'CANCELLED', 'FAILED', 'EXPIRED']) {
      const [o] = find([offer()], [['AA'.repeat(32), status]])
      expect(o).toMatchObject({ kind: 'stale' })
      expect(o!.why).toContain(status)
    }
  })

  it('reports a finished listing\'s open offer as exposed rather than stale', () => {
    const [o] = find([offer({ destination: null })], [['AA'.repeat(32), 'CANCELLED']])
    expect(o!.kind).toBe('exposed')
  })

  it('reports a buy offer with no listing as inert (it cannot move a ticket by itself)', () => {
    const [o] = find([offer({ isSell: false, destination: null })])
    expect(o).toMatchObject({ kind: 'inert' })
    expect(o!.why).toMatch(/buy offer/)
  })

  it('handles many offers independently', () => {
    const offers = [
      offer({ index: '01'.repeat(32) }),
      offer({ index: '02'.repeat(32), destination: null }),
      offer({ index: '03'.repeat(32) }),
    ]
    const out = find(offers, [['03'.repeat(32), 'ACTIVE']])
    expect(out.map((o) => [o.offer.index.slice(0, 2), o.kind])).toEqual([
      ['01', 'inert'],
      ['02', 'exposed'],
    ])
  })
})

describe('cancellableByBroker', () => {
  it('can tidy up what only it could ever match', () => {
    const [o] = find([offer()])
    expect(cancellableByBroker(o!, BROKER)).toBe(true)
    const [stale] = find([offer()], [['AA'.repeat(32), 'SOLD']])
    expect(cancellableByBroker(stale!, BROKER)).toBe(true)
  })

  it('never claims an exposed offer: that is for the organizer to cancel', () => {
    const [o] = find([offer({ destination: OTHER })])
    expect(cancellableByBroker(o!, BROKER)).toBe(false)
    const [open] = find([offer({ destination: null })])
    expect(cancellableByBroker(open!, BROKER)).toBe(false)
  })

  it('a buy offer destined elsewhere is not its to cancel either', () => {
    const [o] = find([offer({ isSell: false, destination: OTHER })])
    expect(cancellableByBroker(o!, BROKER)).toBe(false)
  })
})
