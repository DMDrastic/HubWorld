/**
 * How a signature is requested on a phone.
 *
 * A QR is an instruction to a SECOND device. On a desktop that is right — the
 * phone holding the keys scans the screen. On a phone it is a dead end, and
 * until `next` was wired through, every signing flow did exactly that: sign-in,
 * minting, gifting, listing, buying, bidding and door check-in all rendered a
 * QR you cannot scan with the device showing it. The whole product, unusable on
 * the device most attendees actually hold.
 *
 * The deep link was never missing — Xaman returns it, the backend has always
 * passed it through as `next`. The frontend dropped it on the floor.
 *
 * The case worth guarding hardest is STUB mode. It returns
 * `hubworld-stub://sign/<uuid>`, which opens nothing at all; rendering that as a
 * button gives a control that visibly does nothing, which is worse than no
 * control and would only ever be discovered by tapping it in a demo.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QrCode } from '@/components/QrCode'

const QR = 'data:image/png;base64,AAAA'
const LINK = 'https://xumm.app/sign/abc-123'

describe('the Xaman signing prompt', () => {
  it('offers the deep link when talking to real Xaman', () => {
    render(<QrCode src={QR} alt="sign in" next={LINK} mode="live" />)

    const link = screen.getByRole('link', { name: /open in xaman/i })
    expect(link.getAttribute('href')).toBe(LINK)
  })

  it('withholds the link in stub mode, where it opens nothing', () => {
    // hubworld-stub://sign/... is not a real scheme. A button that does nothing
    // is worse than no button, and only shows itself when someone taps it.
    render(<QrCode src={QR} alt="sign in" next="hubworld-stub://sign/abc" mode="stub" />)

    expect(screen.queryByRole('link', { name: /open in xaman/i })).toBeNull()
  })

  it('still renders the QR when there is no link at all', () => {
    // The pre-existing behaviour has to survive: a caller that passes no `next`
    // gets exactly what it got before.
    render(<QrCode src={QR} alt="sign in" />)

    expect(screen.getByAltText('sign in')).not.toBeNull()
    expect(screen.queryByRole('link', { name: /open in xaman/i })).toBeNull()
  })

  it('keeps the QR in the document alongside the link', () => {
    // The QR is hidden by a media query on narrow screens, NOT removed — a
    // wider screen must still get it without a re-render or a second request.
    render(<QrCode src={QR} alt="sign in" next={LINK} mode="live" />)

    expect(screen.getByAltText('sign in')).not.toBeNull()
  })

  it('opens in the same tab, so the polling loop survives', () => {
    // The page holding the poll is what notices the signature when the user
    // comes back. target="_blank" would background it behind Xaman's return.
    render(<QrCode src={QR} alt="sign in" next={LINK} mode="live" />)

    expect(screen.getByRole('link', { name: /open in xaman/i }).getAttribute('target')).toBeNull()
  })
})
