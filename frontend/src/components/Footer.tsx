/**
 * Site footer.
 *
 * Three jobs, in order of how much they matter:
 *
 * 1. SAY WHICH LEDGER THIS IS. On anything but mainnet the tickets are not real
 *    and the money is not real, and someone arriving from a link deserves to be
 *    told without having to notice a small chip in the nav. Like every other
 *    network claim in the app it is DERIVED from /api/health — the landing page
 *    once hardcoded "Live on XRPL testnet", which was true the day it was
 *    written and would have become a lie the moment XRPL_NETWORK changed.
 *
 * 2. State the custody position, because it is the product's central claim and
 *    it is verifiable rather than marketing: HubWorld holds no user keys and
 *    sale funds never rest with it.
 *
 * 3. Copyright and provenance.
 *
 * DELIBERATELY ABSENT: Terms, Privacy, and any company registration details.
 * Those pages do not exist, and `router.ts` falls unknown paths back to the Hub
 * rather than 404ing — so a link to /terms would render the Hub and look like it
 * had worked, which is worse than no link. They belong here once they exist, as
 * real routes, with a real legal entity behind them.
 */
import type { Health } from '@/lib/api'
import { useLinkHandler } from '@/lib/router'

const REPO = 'https://github.com/DMDrastic/HubWorld'
const XRPL = 'https://xrpl.org'

export function Footer({ health }: { health: Health | null }) {
  const link = useLinkHandler()
  // Computed, not hardcoded — a literal year silently rots every January.
  const year = new Date().getFullYear()
  const network = health?.network

  return (
    <footer className="border-t">
      <div className="text-muted-foreground mx-auto max-w-6xl px-4 py-10 text-sm">
        {/* The caveat leads, and only when there is one to make. On mainnet this
            is absent: it is simply the product, and a notice there would be
            developer chrome in front of a paying customer. */}
        {(network === 'testnet' || network === 'devnet') && (
          <p className="bg-muted/50 mb-8 rounded-xl border px-4 py-3 leading-relaxed">
            <span className="text-foreground font-medium">
              Running on the XRPL {network}.
            </span>{' '}
            Tickets, payments and balances here are test data on a public test
            network. Nothing has real-world value, and no real money is involved.
          </p>
        )}

        <div className="grid gap-8 sm:grid-cols-[1.5fr_1fr_1fr]">
          <div className="space-y-3">
            <div className="text-foreground text-[0.95rem] font-semibold tracking-tight">
              HubWorld
            </div>
            <p className="max-w-sm leading-relaxed text-pretty">
              Event ticketing on the XRP Ledger. Your tickets are NFTs held in
              your own wallet — HubWorld never holds your keys, and sale funds
              never rest with us.
            </p>
          </div>

          <nav className="space-y-2.5" aria-label="Footer">
            <div className="text-foreground text-xs font-medium tracking-[0.18em] uppercase">
              Explore
            </div>
            <a href="/events" onClick={link('/events')} className="hover:text-foreground block">
              Events
            </a>
            <a href="/market" onClick={link('/market')} className="hover:text-foreground block">
              Marketplace
            </a>
          </nav>

          <nav className="space-y-2.5" aria-label="Project">
            <div className="text-foreground text-xs font-medium tracking-[0.18em] uppercase">
              Project
            </div>
            {/* External, so a real anchor with the usual safety attributes. */}
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground block"
            >
              Source on GitHub
            </a>
            <a
              href={XRPL}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground block"
            >
              XRP Ledger
            </a>
          </nav>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t pt-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} HubWorld. Built on the XRP Ledger.</p>
          {/* Which build is serving. Quiet, but it turns "it is broken on my
              machine" into a specific commit without anyone opening DevTools. */}
          {health?.commit && health.commit !== 'unknown' && (
            <p className="font-mono opacity-60">build {health.commit.slice(0, 7)}</p>
          )}
        </div>
      </div>
    </footer>
  )
}
