/**
 * Site footer.
 *
 * Two jobs, in order of how much they matter:
 *
 * 1. State the custody position, because it is the product's central claim and
 *    it is verifiable rather than marketing: HubWorld holds no user keys and
 *    sale funds never rest with it.
 *
 * 2. Copyright and provenance.
 *
 * It is one quiet row of links over two short lines of small print. The earlier
 * three-column footer gave a two-link site the weight of a sitemap, and labelled
 * each column in tracked capitals above one or two links.
 *
 * NOT HERE: a test-network notice. It used to lead the footer ("Running on the
 * XRPL testnet ... no real money is involved") and was removed on request. The
 * nav's network badge and the landing page's ledger line still say which network
 * this is, both derived from /api/health, so nothing here claims one.
 *
 * DELIBERATELY ABSENT: Terms, Privacy, and any company registration details.
 * Those pages do not exist, and `router.ts` falls unknown paths back to the Hub
 * rather than 404ing — so a link to /terms would render the Hub and look like it
 * had worked, which is worse than no link. They belong here once they exist, as
 * real routes, with a real legal entity behind them.
 */
import type { Health } from '@/lib/api'
import { useLinkHandler } from '@/lib/router'

const XRPL = 'https://xrpl.org'

export function Footer({ health }: { health: Health | null }) {
  const link = useLinkHandler()
  // Computed, not hardcoded — a literal year silently rots every January.
  const year = new Date().getFullYear()

  const quiet = 'hover:text-foreground focus-visible:ring-ring rounded focus-visible:ring-2 focus-visible:outline-none'

  return (
    <footer className="border-t">
      <div className="text-muted-foreground mx-auto max-w-6xl px-4 py-8 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a
              href="/"
              onClick={link('/')}
              className="text-foreground focus-visible:ring-ring rounded font-semibold tracking-tight focus-visible:ring-2 focus-visible:outline-none"
            >
              HubWorld
            </a>
            <a href="/events" onClick={link('/events')} className={quiet}>
              Events
            </a>
            <a href="/market" onClick={link('/market')} className={quiet}>
              Marketplace
            </a>
            {/* External, so a real anchor with the usual safety attributes. */}
            <a href={XRPL} target="_blank" rel="noreferrer noopener" className={quiet}>
              XRP Ledger
            </a>
          </nav>

          {/* Which build is serving. Quiet, but it turns "it is broken on my
              machine" into a specific commit without anyone opening DevTools. */}
          {health?.commit && health.commit !== 'unknown' && (
            <p className="font-mono text-xs opacity-60">build {health.commit.slice(0, 7)}</p>
          )}
        </div>

        <p className="mt-6 max-w-xl leading-relaxed text-pretty">
          Event ticketing on the XRP Ledger. Your tickets are NFTs held in your own wallet —
          HubWorld never holds your keys, and sale funds never rest with us.
        </p>
        <p className="mt-3 text-xs">© {year} HubWorld. Built on the XRP Ledger.</p>
      </div>
    </footer>
  )
}
