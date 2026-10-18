/**
 * The signed-out landing page.
 *
 * VISUAL TREATMENT (2026-10 rebuild #4, scoped to this file + `LandingAuctionDemo`
 * + `LandingPhoneShowcase` only — see frontend/CLAUDE.md for why the rest of
 * the app, NavBar included, stays violet). The visual system — Mobbin's
 * neutral grayscale palette, pill buttons, one big soft-shadowed card, one
 * typeface (Geist) — is unchanged from the prior pass and not re-litigated
 * here. What changed is the CONTENT ARCHITECTURE and COPY, following a
 * product-first repositioning brief: Hubworld is a ticketing product first,
 * and XRPL is the machinery underneath it, not the pitch. Six sections,
 * down from the prior pass's two:
 *
 *   1. Hero — what Hubworld is, no XRPL mention.
 *   2. Lifecycle — the phone-scroll showcase, now carrying rewritten,
 *      benefit-first step copy (see LandingPhoneShowcase.tsx's own comment).
 *   3. Organizer value — the commercial core: royalties, resale control,
 *      one connected system.
 *   4. Secondary market — the auction demo, MOVED here from the hero. It was
 *      the hero's main proof card in the prior pass; under this structure
 *      it's evidence for one specific claim ("a secondary market you're
 *      part of"), not the first thing a visitor who doesn't know what
 *      Hubworld is yet should see. A lighter hero — headline, subhead, two
 *      CTAs, nothing else — is both cleaner and more honest about what it's
 *      actually showing.
 *   5. Trust — "Ownership you can verify," stated as a benefit, not a
 *      mechanism. No ledger explanation here; that is what the GitHub link
 *      in §6 and the Footer are for.
 *   6. Final CTA — organizer-focused, with one proof line folded in rather
 *      than its own section (a single sentence of credibility doesn't earn
 *      a whole scroll stop).
 *
 * The three custody facts that used to sit in the hero as a trust strip
 * moved to §5, where "Ownership you can verify" is actually about; the hero
 * no longer carries them, per the brief's "keep the hero clean" instruction.
 *
 * XRPL ITSELF appears exactly once in this file's own content — the quiet
 * `liveOn()` line at the very bottom, immediately before the shared
 * `Footer` (which independently carries its own, more detailed "Built on
 * the XRP Ledger" line — see Footer.tsx). Keeping a minimal line here too is
 * not redundant copy for its own sake: `Landing.test.tsx` pins that this
 * page states the correct network on its own, independent of the Footer,
 * so a /api/health regression is caught here even if the two ever drift.
 *
 * COLOR / TYPE / SHADOW: unchanged from the prior pass. See `--accent`
 * below and `LandingAuctionDemo`'s own comment for the validation.
 */
import { SignIn } from '@/components/SignIn'
import { LandingAuctionDemo } from '@/components/LandingAuctionDemo'
import { LandingPhoneShowcase } from '@/components/LandingPhoneShowcase'
import { Button } from '@/components/ui/button'
import type { AuthUser, Health } from '@/lib/api'

const REPO = 'https://github.com/DMDrastic/HubWorld'

/**
 * What the quiet closing line claims, given what we actually know. True on
 * every network as written; the qualifier is added ONLY when the server has
 * told us it is a test network. Pinned by `Landing.test.tsx`, which also
 * pins that this string must never contain the word "testnet"/"devnet" on
 * mainnet.
 */
function liveOn(network: Health['network']): string {
  return network === 'testnet' || network === 'devnet'
    ? `Live on XRPL ${network}`
    : 'Live on the XRP Ledger'
}

const LIFECYCLE = ['Buy', 'Gift', 'Resell', 'Auction', 'Check in'] as const

const ORGANIZER_VALUE = [
  {
    title: 'Earn from resale',
    body: "Set a royalty on every resale, and it's paid automatically — no chasing payments after the fact.",
  },
  {
    title: 'Control resale',
    body: 'Cap resale at a percentage of face value, a fixed price, or turn it off entirely. Your event, your rules.',
  },
  {
    title: 'Stay connected',
    body: 'Primary sales, resale, auctions, and check-in all stay part of one system — not four disconnected tools.',
  },
] as const

export function Landing({
  onAuthenticated,
  network,
}: {
  onAuthenticated: (u: AuthUser) => void
  /** From /api/health. Undefined until it loads, or on an API too old to say. */
  network?: Health['network']
}) {
  return (
    <div
      className="space-y-20 pb-16 [--accent:#0d7a89] sm:space-y-24 dark:[--accent:#12a0b0]"
      style={{
        // Five blobs down the page rather than one or two near the top —
        // a radial-gradient's radius is a percentage OF ITS OWN BOX, and
        // that box is now the whole page (several thousand px tall across
        // six sections), so a couple of top-anchored blobs sized the way
        // the single-section version used to be would either balloon to
        // cover the entire page (washing everything the same colour) or
        // vanish within the first screenful, depending on which axis
        // "percent" was read against. Sizing each blob in `vh` instead
        // keeps every one a consistent, moderate size regardless of total
        // page height; POSITION is still a percentage (`at X% Y%`), which
        // is exactly what should scale with page length — it is what
        // spreads the five down the page rather than bunching near the
        // top. Alternating left/right keeps it from reading as one column
        // of colour. Built from the landing page's own scoped `--accent`
        // (teal, not the app's violet `--primary` — see the root class
        // above), via the same `color-mix` technique the app's existing
        // `.aurora` utility already proves (index.css, used on Hub) — not
        // reused directly since `.aurora` is hardcoded to `--primary`.
        // `color-mix` recomputes against `--accent` live, so this is
        // already correct in both themes without a separate dark case.
        backgroundImage: [
          'radial-gradient(50vh 50vh at 18% 0%, color-mix(in oklch, var(--accent) 30%, transparent) 0%, transparent 70%)',
          'radial-gradient(46vh 46vh at 86% 20%, color-mix(in oklch, var(--accent) 24%, transparent) 0%, transparent 70%)',
          'radial-gradient(52vh 52vh at 8% 46%, color-mix(in oklch, var(--accent) 26%, transparent) 0%, transparent 70%)',
          'radial-gradient(46vh 46vh at 92% 70%, color-mix(in oklch, var(--accent) 22%, transparent) 0%, transparent 70%)',
          'radial-gradient(50vh 50vh at 20% 94%, color-mix(in oklch, var(--accent) 28%, transparent) 0%, transparent 70%)',
        ].join(', '),
      }}
    >
      {/* ------------------------------------------------------------- 1.
          Hero. Headline, one line of subtext, two pill CTAs — nothing else.
          No XRPL mention, no proof card, no trust strip (trust lives in §5,
          where it's actually about something). Backdrop gradient now lives
          on the root wrapper above (see its own comment) so it carries
          through the whole page, not just this section. */}
      <section className="pt-16 sm:pt-20">
        <div className="mx-auto max-w-2xl px-4 text-center">
          <h1 className="text-foreground text-5xl leading-[1.05] font-bold tracking-[-0.025em] text-balance sm:text-6xl">
            Every ticket you hold, in one hub.
          </h1>
          <p className="text-muted-foreground mx-auto mt-5 max-w-md text-lg leading-relaxed text-pretty">
            Buy, gift, resell and check in — all from one place, while organizers stay connected
            to what happens after the first sale.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {/* `SignIn` always renders inside a `Card`; the `data-slot` hooks
                (its documented extension point) collapse that chrome down to
                a bare pill for the idle state. This is the ONE live `SignIn`
                mounted on the page — §6's CTA anchors back to it rather than
                mounting a second instance. */}
            <div
              id="hero-signin"
              className="[&_[data-slot=card-content]]:p-0 [&_[data-slot=card-header]]:hidden [&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:p-0 [&_[data-slot=card]]:shadow-none [&_[data-slot=card]]:ring-0"
            >
              <SignIn
                onAuthenticated={onAuthenticated}
                primaryButtonLabel="Explore Hubworld"
                primaryButtonClassName="h-12 rounded-full bg-foreground px-7 text-[0.95rem] text-background hover:bg-foreground/85"
              />
            </div>
            <Button asChild variant="secondary" size="lg" className="h-12 rounded-full px-6 text-[0.95rem]">
              <a href="#organizers">For organizers</a>
            </Button>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 2.
          Lifecycle. The phone-scroll showcase, unchanged logic — see
          LandingPhoneShowcase.tsx for the real-iPhone frame and the
          rewritten, benefit-first step copy. The five-word strip above it
          is the same lifecycle stated in one line before the phone states
          it again in five scroll-driven scenes — a short, scannable version
          for anyone who doesn't scroll further. */}
      <section id="lifecycle" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl space-y-10 px-4">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="text-foreground text-3xl leading-snug font-semibold tracking-tight text-balance sm:text-4xl">
              One ticket, start to finish.
            </h2>
            <p className="text-muted-foreground mt-3 text-base leading-relaxed text-pretty">
              Buy it, gift it, resell it, or bid on it — then walk in with a scan. Every step is
              verifiable, without you ever having to think about how.
            </p>
            <div className="text-muted-foreground mt-5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-sm font-medium">
              {LIFECYCLE.map((step, i) => (
                <span key={step} className="flex items-center gap-2">
                  {i > 0 && (
                    <span aria-hidden className="text-muted-foreground/50">
                      →
                    </span>
                  )}
                  <span className="text-foreground">{step}</span>
                </span>
              ))}
            </div>
          </div>
          <LandingPhoneShowcase />
        </div>
      </section>

      {/* ------------------------------------------------------------- 3.
          Organizer value. The commercial core — three equal-weight cards,
          practical and scannable rather than editorial. No featured card,
          no bento asymmetry: that flourish belongs in sections that already
          have a real visual (§2 and §4), not this one. */}
      <section id="organizers" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="text-foreground text-3xl leading-snug font-semibold tracking-tight text-balance sm:text-4xl">
              Built for organizers who want a say in what happens next.
            </h2>
            <p className="text-muted-foreground mt-3 text-base leading-relaxed text-pretty">
              Primary sales are only the start. Hubworld keeps you connected to every resale
              after.
            </p>
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {ORGANIZER_VALUE.map((c) => (
              <div key={c.title} className="bg-card ring-foreground/8 elevate rounded-2xl p-6 ring-1">
                <h3 className="text-foreground text-sm font-medium tracking-tight">{c.title}</h3>
                <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed text-pretty">
                  {c.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 4.
          Secondary market. The auction demo, moved here from the hero — see
          file-top comment for why. Same soft-shadowed card treatment the
          hero used to carry it with. */}
      <section>
        <div className="mx-auto max-w-6xl px-4">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="text-foreground text-3xl leading-snug font-semibold tracking-tight text-balance sm:text-4xl">
              A secondary market you&rsquo;re actually part of.
            </h2>
            <p className="text-muted-foreground mt-3 text-base leading-relaxed text-pretty">
              Tickets can be resold at a fixed price or bid on in a live auction — and your resale
              rules and royalty travel with every sale, automatically.
            </p>
          </div>
          <div className="mx-auto mt-10 max-w-3xl">
            <div className="bg-muted rounded-[28px] p-3 shadow-[0_2px_4px_hsl(var(--shadow-color)/0.12),0_18px_40px_-10px_hsl(var(--shadow-color)/0.24),0_48px_100px_-28px_hsl(var(--shadow-color)/0.3)] sm:p-4">
              <LandingAuctionDemo />
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 5.
          Trust. Stated as a benefit, not a mechanism — no ledger
          explanation here. The three custody facts that used to sit in the
          hero as a trust strip belong here instead, where the section is
          actually about trust. */}
      <section>
        <div className="mx-auto max-w-2xl px-4 text-center">
          <h2 className="text-foreground text-3xl leading-snug font-semibold tracking-tight text-balance sm:text-4xl">
            Ownership you can verify.
          </h2>
          <p className="text-muted-foreground mt-3 text-base leading-relaxed text-pretty">
            Every ticket carries its own history — who&rsquo;s held it, and when — so a
            screenshot can never stand in for the real thing.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------- 6.
          Final CTA. Organizer-focused and deliberately calm — one button,
          not a competing pair, and the proof line folded in underneath
          rather than given its own section. "See how it works" points at
          the real GitHub source (the same link the Footer already uses)
          rather than a technical page that doesn't exist — Footer.tsx
          explains why an honest destination matters more than a tidy one. */}
      <section>
        <div className="mx-auto max-w-2xl px-4 text-center">
          <h2 className="text-foreground text-3xl leading-snug font-semibold tracking-tight text-balance sm:text-4xl">
            Building an event?
          </h2>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md text-base leading-relaxed text-pretty">
            We&rsquo;re opening a small number of organizer pilots for a more flexible approach to
            ticketing and resale.
          </p>
          <div className="mt-8 flex justify-center">
            <Button
              asChild
              size="lg"
              className="h-12 rounded-full bg-foreground px-7 text-[0.95rem] text-background hover:bg-foreground/85"
            >
              <a href="#hero-signin">Talk to us</a>
            </Button>
          </div>
          <p className="text-muted-foreground mx-auto mt-6 max-w-sm text-xs leading-relaxed">
            Built and tested through a full mainnet rehearsal — real tickets, real settlement.{' '}
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer noopener"
              className="text-foreground underline underline-offset-2"
            >
              See how it works
            </a>
          </p>
        </div>
      </section>

      <p className="text-muted-foreground text-center text-xs">{liveOn(network)}</p>
    </div>
  )
}
