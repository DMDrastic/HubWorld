/**
 * The signed-out landing page.
 *
 * CRAFT PASS (2026-10, same three-file scope, content/architecture
 * unchanged). The owner's read on rebuild #4 was "bland" in both themes —
 * verified against actual screenshots, not assumed. What was flat, per
 * section: the background gradient was present but nearly invisible on most
 * surfaces (opacity/size tuned up, see the root wrapper below); the hero sat
 * static with no entrance moment or button feedback; the organizer-value
 * cards were three identical icon-less boxes (now a 2-up bento with real
 * icons — see §3's own comment for why one is featured); the auction-demo
 * card's own comment described a "peeking card" depth effect that was never
 * actually built (now is, see §4); and the trust section was the fourth of
 * six sections built as pure centered text, which is the literal pattern
 * CLAUDE.md's §5 names as a default to avoid (now split into a claim + a
 * small real provenance diagram, see §5). The single biggest flat stretch
 * wasn't in this file at all — `LandingPhoneShowcase`'s step column reserves
 * 42-65vh per step and most of that was empty space; see that file's own
 * comment for the progress rail and active/inactive emphasis added there.
 * Every addition is a plain CSS transition on state the page already
 * computes, covered by index.css's existing global `prefers-reduced-motion`
 * rule — no new motion plumbing.
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
 *
 * FULL-BLEED BACKGROUND (2026-10, following a layout report). `App.tsx`
 * mounts this page inside `<main className="mx-auto max-w-6xl px-4 ...">`,
 * so the root wrapper's own background — including the gradient below —
 * was constrained to that 1152px column too: on any viewport wider than
 * ~1200px, the true viewport edges showed plain, unstyled `--background`
 * (near-black in dark mode) outside it, reading as flat black bars down
 * both sides. The root wrapper now escapes that constraint with the
 * standard `w-screen` / `mx-[calc(50%-50vw)]` full-bleed trick (pulling a
 * 100vw-wide box's margins back to the true viewport edge) — applied once,
 * to the whole page. Every section's own `mx-auto max-w-*` wrapper is
 * unchanged and still centers its actual content at the same width as
 * before; only the background (color + gradient) now paints to the true
 * screen edge behind it.
 *
 * `overflow-x-clip`, NOT `overflow-x-hidden` — this is load-bearing, found
 * by testing rather than reasoning about it in the abstract.
 * `position: sticky` in `LandingPhoneShowcase` genuinely broke under
 * `hidden`: a Playwright check scrolling through the five steps showed the
 * phone's Y position drifting hundreds of pixels instead of holding
 * steady, because an ancestor with `overflow-x: hidden` computes
 * `overflow-y: auto` (CSS2.1's "the other axis becomes auto" rule), which
 * is enough to make that ancestor the nearest scrolling container sticky
 * resolves against — even though nothing about this wrapper actually
 * scrolls independently of the page. `overflow-x: clip` solves the same
 * 100vw-scrollbar problem `hidden` was added for, WITHOUT establishing a
 * scroll container at all (clip deliberately does not, per spec), so
 * sticky keeps resolving against the real page. Re-tested after the swap:
 * the phone's Y position holds within a few px across all five steps.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link2, SlidersHorizontal, TrendingUp } from 'lucide-react'
import { SignIn } from '@/components/SignIn'
import { LandingAuctionDemo } from '@/components/LandingAuctionDemo'
import { LandingPhoneShowcase } from '@/components/LandingPhoneShowcase'
import { Button } from '@/components/ui/button'
import type { AuthUser, Health } from '@/lib/api'

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

/**
 * SURFACE PASS + SCROLL REVEAL (2026-10). Owner read on the colour work:
 * "too white and no variance" in light mode. Screenshots confirmed it — the
 * page was ONE tone (a ~#ecf0f4 canvas under white cards, a 5% luminance
 * step), so nothing separated one section from the next and the cards only
 * read through a violet-tinted blur shadow. It now has four tonal levels, the
 * way a fintech dashboard does: a deeper cool-slate CANVAS, a recessed PANEL
 * (the secondary-market section sits in one), hairline-bordered white CARDS
 * with a crisp inset-highlight shadow, and an INK panel (the closing CTA).
 * Tones are declared once on the root wrapper as `--canvas` / `--panel`, per
 * theme, like `--accent` and the wash percentages already are. Light mode
 * also scopes `--muted-foreground` and `--live` darker than the app default,
 * because a deeper canvas costs contrast and measurement found the shipped
 * `text-live` badge already below 4.5:1 on its own tint.
 *
 * `Reveal` is the ONE entrance used by §3-§6: opacity + an 20px rise,
 * the same duration and exponential ease-out everywhere, staggered by at most
 * three 90ms steps within a block. Same distance and curve on every unit is
 * what makes it one rhythm rather than per-element effects. Not applied to
 * the hero (own mount animation) or §2 (sticky mechanic).
 */
function useRevealed(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
  // Nothing is ever hidden when it cannot be revealed: reduced motion, or no
  // IntersectionObserver (jsdom, very old browsers), start out shown.
  const [shown, setShown] = useState(
    () =>
      typeof window === 'undefined' ||
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  )
  useEffect(() => {
    const el = ref.current
    if (shown || !el) return
    const io = new IntersectionObserver(
      (entries) => {
        // Also reveal anything already ABOVE the viewport (anchor jump,
        // restored scroll position) — it will never intersect again.
        if (entries.some((e) => e.isIntersecting || e.boundingClientRect.top < 0)) {
          setShown(true)
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    )
    io.observe(el)
    // IntersectionObserver reports crossings, so a jump that skips a unit
    // entirely (anchor link, scrollbar drag) never fires for it. This
    // passive listener catches that one case: the unit is already behind us.
    const onScroll = () => {
      if (el.getBoundingClientRect().bottom < 0) {
        setShown(true)
        io.disconnect()
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      io.disconnect()
      window.removeEventListener('scroll', onScroll)
    }
  }, [shown])
  return [ref, shown]
}

function Reveal({
  children,
  step = 0,
  className = '',
}: {
  children: ReactNode
  /** 0-2: position in the block's stagger. */
  step?: 0 | 1 | 2
  className?: string
}) {
  const [ref, shown] = useRevealed()
  return (
    <div
      ref={ref}
      data-reveal={shown ? 'shown' : 'hidden'}
      style={{ transitionDelay: shown ? `${step * 90}ms` : undefined }}
      className={`transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        shown ? 'translate-y-0 opacity-100' : 'translate-y-5 opacity-0'
      } ${className}`}
    >
      {children}
    </div>
  )
}

/** Card surface: hairline + crisp inset highlight, slate-tinted not violet. */
const CARD_SURFACE =
  'bg-card ring-1 ring-foreground/10 shadow-[inset_0_1px_0_rgb(255_255_255/0.85),0_1px_2px_rgb(15_23_42/0.07),0_10px_28px_-12px_rgb(15_23_42/0.18)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04),0_1px_2px_rgb(0_0_0/0.4),0_14px_32px_-14px_rgb(0_0_0/0.65)]'

const LIFECYCLE = ['Buy', 'Gift', 'Resell', 'Auction', 'Check in'] as const

/** The trust section's provenance diagram — real stages, not decoration. */
const PROVENANCE = ['Minted', 'Held', 'Resold', 'Checked in'] as const

/**
 * The featured card's "up to 20%" is `MAX_ROYALTY_BPS`'s default (2000 bps,
 * backend/src/env.ts) stated as a percentage — a real platform default, not a
 * made-up figure, so it earns the emphasis the featured card gives it.
 */
const ORGANIZER_VALUE = [
  {
    title: 'Earn from resale',
    body: 'Set your own royalty on every resale. It is paid automatically — no chasing payments after the fact.',
    figure: 'Up to 20%',
    icon: TrendingUp,
    featured: true,
  },
  {
    title: 'Control resale',
    body: 'Cap resale at a percentage of face value, a fixed price, or turn it off entirely. Your event, your rules.',
    icon: SlidersHorizontal,
    figure: null,
    featured: false,
  },
  {
    title: 'Stay connected',
    body: 'Primary sales, resale, auctions, and check-in all stay part of one system — not four disconnected tools.',
    icon: Link2,
    figure: null,
    featured: false,
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
      className="relative isolate w-screen space-y-20 overflow-x-clip bg-[linear-gradient(to_bottom,var(--canvas)_calc(100%-12rem),var(--background))] pb-16
        [--canvas:#e3e8ef] [--panel:#d5dce7] [--lift:60%] [--muted-foreground:#4f5565] [--live:#116a30]
        [--accent:#007da2] [--wash-tint:3.5%] [--wash-1:12%] [--wash-2:9.5%] [--wash-3:8%] [--wash-4:9.5%] [--wash-5:9.5%] [--wash-6:11%] [--wash-glow:0%] [--wash-dot:20%]
        mx-[calc(50%-50vw)] sm:space-y-24
        dark:[--canvas:#09090d] dark:[--panel:#0e151c] dark:[--lift:0%] dark:[--muted-foreground:#9b9aa7] dark:[--live:#3fb463]
        dark:[--accent:#00aed4] dark:[--wash-tint:6%] dark:[--wash-1:20%] dark:[--wash-2:17%] dark:[--wash-3:14%] dark:[--wash-4:17%] dark:[--wash-5:17%] dark:[--wash-6:19%] dark:[--wash-glow:15%] dark:[--wash-dot:30%]"
    >
      {/* COLOUR PASS (2026-10). Diagnosed from screenshots: five isolated
          blobs read as smudges with flat, dead neutral between them, and the
          phone-showcase step column (42-65vh per step) was the worst of it.
          Replaced with one continuous atmosphere, in three quiet layers:
          (1) the canvas itself carries ~2.5% of the accent, so there is no
          pure-grey "nothing" anywhere; (2) wide, overlapping, low-chroma
          washes that bleed into each other down the page instead of sitting
          as islands, plus a single warm wash beside the phone that answers
          its orange bezel; (3) a hairline dot grid, faded at top and bottom,
          that gives empty stretches texture without adding content.
          Lives in a -z-10 child of an `isolate`d root so it paints above the
          root background and below every section, and changes nothing about
          the sticky phone. Static, so reduced motion needs nothing.

          Peak wash percentages were checked against math alone (a single
          15% layer over a 2.5% canvas tint), which missed that several
          washes genuinely overlap on screen — real pixel sampling of
          rendered `text-muted-foreground` body copy over those overlap
          zones measured as low as 2.46:1 in light mode, well under WCAG
          AA's 4.5:1 floor for body text (frontend/CLAUDE.md §4). Percentages
          below are reduced (~40%) from the first pass specifically so those
          overlaps stay compliant; re-verified the same way — real
          screenshots, real `getComputedStyle` text color, real pixel
          sampling at each text element's position, not contrast math on the
          intended values alone.

          ACCENT SATURATION (2026-10, three rounds — "more vibrant," then
          "still not vibrant enough," then "brighter, and dark mode looks
          empty"). `--accent` has moved twice from its original
          `#0b7280`/`#12a0b0`: first to `#00778d`/`#00a6bd` (chroma x1.4-1.5),
          now to `#007da2`/`#00aed4` (chroma x2.3 light / x2.1 dark from the
          ORIGINAL, not compounding on the first bump) — unchanged in this
          third round. Same OKLCH lightness both times (L unchanged — 0.5068
          light, 0.6464 dark) and same hue (~210° light, ~208° dark — still
          teal, nowhere near the violet `frontend/CLAUDE.md` bans): only
          chroma moved, which is why contrast math stays favourable even at
          the second, more aggressive step (WCAG contrast is a luminance
          ratio; chroma at fixed L barely moves it).

          THIRD ROUND — per-theme wash intensity, not a shared bump. By the
          second round light mode's worst measured body-text contrast had
          already narrowed to 4.59:1 (real pixel sampling, not math) —
          pushing it uniformly higher again risked a real AA failure. Dark
          mode's worst case was 6.86:1, with real headroom to spend. So the
          wash percentages (`--wash-tint`/`--wash-1`..`--wash-6`/`--wash-dot`
          below) are now DIFFERENT per theme — declared as bracket-override
          custom properties on the root wrapper, the exact same mechanism
          `--accent` already uses for its own light/dark split — rather than
          one shared set of numbers read by both. Light stayed at the
          second-round values (12/9.5/8/9.5/9.5/11%, tint 3.5%, dots 20%);
          dark went up substantially (20/17/14/17/17/19%, tint 6%, dots 30%),
          since the measured headroom was there to spend.

          A new `--wash-glow` stop was also added — one large, soft,
          centre-weighted radial sitting behind every other wash in paint
          order, 0% in light mode (so it costs nothing there, fully
          transparent) and 15% in dark mode: the literal "add a gradient
          overlay so dark mode doesn't look so empty" ask, implemented as a
          genuinely new layer rather than just turning existing numbers up —
          and dark-exclusive by VALUE on a shared custom property, the same
          technique as everything else here, rather than a second
          conditionally-rendered DOM element.

          Re-verified the same way every round, not reasoned about in the
          abstract: real screenshots, real `getComputedStyle` text colour,
          real pixel sampling of rendered `text-muted-foreground` body copy
          at each paragraph's actual on-screen position (not a flat-surface
          assumption) — see the verification notes for the measured numbers
          at each step, including this one. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          // Canvas tint (layer 1 of the comment above) lives here rather
          // than on the root so the fades below can dissolve it at both
          // ends — a tinted root ended in a hard seam against the footer.
          backgroundImage: [
            'linear-gradient(color-mix(in oklch, var(--accent) var(--wash-tint), transparent), color-mix(in oklch, var(--accent) var(--wash-tint), transparent))',
            // The dark-mode-only "fill the emptiness" overlay: one large,
            // soft, centre-weighted glow with nothing to compete against it
            // (it sits BEHIND every other stop in paint order, so the
            // existing washes still read as distinct shapes on top of it).
            // `--wash-glow` is 0% in light mode, so this stop is fully
            // transparent there and costs nothing — the overlay is additive
            // and dark-exclusive by VALUE, not by a second conditional DOM
            // element, the same technique `--accent` itself already uses.
            'radial-gradient(85vw 70vh at 50% 45%, color-mix(in oklch, var(--accent) var(--wash-glow), transparent), transparent 75%)',
            'radial-gradient(90vw 46vh at 50% 0%, color-mix(in oklch, var(--accent) var(--wash-1), transparent), transparent 72%)',
            'radial-gradient(70vw 60vh at 100% 24%, color-mix(in oklch, var(--accent) var(--wash-2), transparent), transparent 72%)',
            'radial-gradient(60vw 50vh at 0% 20%, color-mix(in oklch, oklch(0.8 0.1 65) var(--wash-3), transparent), transparent 72%)',
            'radial-gradient(80vw 60vh at 0% 54%, color-mix(in oklch, var(--accent) var(--wash-4), transparent), transparent 72%)',
            'radial-gradient(80vw 56vh at 100% 76%, color-mix(in oklch, var(--accent) var(--wash-5), transparent), transparent 72%)',
            'radial-gradient(90vw 50vh at 50% 100%, color-mix(in oklch, var(--accent) var(--wash-6), transparent), transparent 72%)',
            // Light-mode lift: the hero opens airy and the canvas deepens
            // down the page. 0% (transparent) in dark.
            'linear-gradient(180deg, color-mix(in oklch, white var(--lift), transparent), transparent 48vh)',
          ].join(', '),
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(circle, color-mix(in oklch, var(--accent) var(--wash-dot), transparent) 1px, transparent 1.4px)',
            backgroundSize: '28px 28px',
          }}
        />
        {/* The fade at both ends of the page, as two small overlays in the page's own
            colour instead of a `mask-image` on this whole layer. This layer is as tall
            as the page, and a mask on something that size makes the browser draw the
            layer and its mask off-screen as one huge texture (on a phone: over 1000px
            wide by many thousands tall, twice), which iOS Safari handles by tiling and
            purging while you scroll. The overlays look the same (5% in, 10% out, over
            the page background this sits on) and cost almost nothing. */}
        <div
          className="absolute inset-x-0 top-0 h-[5%]"
          style={{ background: 'linear-gradient(var(--background), transparent)' }}
        />
        <div
          className="absolute inset-x-0 bottom-0 h-[10%]"
          style={{ background: 'linear-gradient(transparent, var(--background))' }}
        />
      </div>
      {/* ------------------------------------------------------------- 1.
          Hero. Headline, one line of subtext, two pill CTAs — nothing else.
          No XRPL mention, no proof card, no trust strip (trust lives in §5,
          where it's actually about something). Backdrop gradient now lives
          on the root wrapper above (see its own comment) so it carries
          through the whole page, not just this section. */}
      <section className="!mt-0 pt-16 sm:pt-20">
        {/* `animate-in` (tw-animate-css, already a project dependency) plays
            once on mount — the "one orchestrated moment" CLAUDE.md asks for,
            not a per-element effect scattered down the page. Reduced motion
            is handled for free: index.css's global `prefers-reduced-motion`
            rule collapses every animation/transition duration to 0.01ms, so
            this and every other CSS-driven motion addition below need no
            separate matchMedia check — only the already-existing rAF loop in
            LandingAuctionDemo does, because it's JS-driven. */}
        <div className="animate-in fade-in slide-in-from-bottom-3 mx-auto max-w-2xl px-4 text-center duration-700 ease-out">
          <h1 className="text-foreground text-5xl leading-[1.03] font-bold tracking-[-0.03em] text-balance sm:text-6xl lg:text-7xl">
            Every ticket you hold, in one hub.
          </h1>
          <p className="text-muted-foreground mx-auto mt-5 max-w-md text-lg leading-relaxed text-pretty">
            Buy, gift, resell and check in — all from one place, while organizers stay connected to
            what happens after the first sale.
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
                // `active:translate-y-px` (press-down) already lives on the
                // shared Button base; `hover:-translate-y-0.5` + the shadow
                // pair it with a lift on approach, so the two together read
                // as one tactile press rather than only a colour change —
                // Button.tsx itself is out of scope, so this is layered on
                // here via className rather than touching the shared component.
                primaryButtonClassName="h-12 rounded-full bg-foreground px-7 text-[0.95rem] text-background transition-transform duration-200 hover:-translate-y-0.5 hover:bg-foreground/85 hover:shadow-lg"
              />
            </div>
            <Button
              asChild
              variant="secondary"
              size="lg"
              className="h-12 rounded-full px-6 text-[0.95rem] transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-md"
            >
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
          Organizer value. Three equal-weight, identically-shaped cards read
          flat — exactly the "same-size icon+heading+text card grid" pattern
          that reads as a lazy default rather than a composed page. Revised
          into a 2-column bento: "Earn from resale" is the commercially
          strongest claim of the three (royalties are revenue; the other two
          are controls), so it leads as the tall, featured card rather than
          winning by coin flip — each card also now carries a real icon
          instead of bare text, and the featured card states the actual
          royalty ceiling (`MAX_ROYALTY_BPS`, see ORGANIZER_VALUE above)
          rather than leaving the claim unquantified. */}
      <section id="organizers" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal className="mx-auto max-w-xl text-center">
            <h2 className="text-foreground text-3xl leading-snug font-semibold tracking-tight text-balance sm:text-4xl">
              Built for organizers who want a say in what happens next.
            </h2>
            <p className="text-muted-foreground mt-3 text-base leading-relaxed text-pretty">
              Primary sales are only the start. Hubworld keeps you connected to every resale after.
            </p>
          </Reveal>
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {ORGANIZER_VALUE.map((c, i) => (
              <Reveal
                key={c.title}
                step={Math.min(i, 2) as 0 | 1 | 2}
                className={
                  c.featured ? 'sm:col-start-1 sm:row-span-2 sm:row-start-1' : 'sm:col-start-2'
                }
              >
                <div
                  className={`${CARD_SURFACE} group h-full rounded-2xl transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:ring-foreground/20 ${
                    c.featured ? 'flex flex-col justify-center p-7 sm:p-8' : 'p-6'
                  }`}
                  style={
                    c.featured
                      ? {
                          backgroundImage:
                            'radial-gradient(120% 70% at 0% 0%, color-mix(in oklch, var(--accent) 9%, transparent), transparent 65%)',
                        }
                      : undefined
                  }
                >
                  {/* Icon chip: the accent as a tinted tile, so it reads as a
                    product-UI element rather than a floating glyph. */}
                  <span
                    className={`inline-flex items-center justify-center rounded-xl bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]/20 ${c.featured ? 'size-12' : 'size-10'}`}
                  >
                    <c.icon
                      aria-hidden
                      className={`text-[var(--accent)] transition-transform duration-300 group-hover:scale-110 ${c.featured ? 'size-6' : 'size-5'}`}
                      strokeWidth={1.75}
                    />
                  </span>
                  {c.figure && (
                    // The page's one commercial number, so it is the display
                    // element of its card rather than a clause in the body.
                    // Sourced: MAX_ROYALTY_BPS default 2000 bps (backend/src/env.ts:61).
                    <p className="text-foreground mt-5 text-5xl leading-none font-semibold tracking-[-0.03em] tabular-nums sm:text-6xl">
                      {c.figure}
                    </p>
                  )}
                  <h3
                    className={`text-foreground font-medium tracking-tight ${c.featured ? 'mt-3 text-lg' : 'mt-3 text-base'}`}
                  >
                    {c.title}
                  </h3>
                  <p
                    className={`text-muted-foreground mt-1.5 leading-relaxed text-pretty ${c.featured ? 'max-w-xs text-sm' : 'text-sm'}`}
                  >
                    {c.body}
                  </p>
                </div>
              </Reveal>
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
          {/* The recessed PANEL tier: one deeper, hairline-bordered surface
             that the white demo card sits on, so this section reads as its
             own region of the page rather than more of the same canvas. */}
          <div className="rounded-[32px] border border-foreground/[0.08] bg-[var(--panel)] px-4 py-12 shadow-[inset_0_1px_0_rgb(255_255_255/0.5)] sm:px-10 sm:py-16 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
            <Reveal className="mx-auto max-w-xl text-center">
              <h2 className="text-foreground text-3xl leading-snug font-semibold tracking-tight text-balance sm:text-4xl">
                A secondary market you&rsquo;re actually part of.
              </h2>
              <p className="text-muted-foreground mt-3 text-base leading-relaxed text-pretty">
                Tickets can be resold at a fixed price or bid on in a live auction — and your resale
                rules and royalty travel with every sale, automatically.
              </p>
            </Reveal>
            {/* `LandingAuctionDemo`'s own top-of-file comment describes "a
              smaller static card peeking from behind it for depth" — that
              described an earlier pass and was never actually built here,
              which is exactly the kind of stale claim this project's
              mistakes log warns about. Built for real now: a second, inert
              card sits behind the live one. It needs `-z-10`, not just DOM
              order — the live card below is a plain static-position div, and
              a static sibling paints ABOVE an absolutely-positioned one of
              equal z-index regardless of source order, so without the
              negative z-index this would render on top of the auction demo
              instead of behind it. `aria-hidden` throughout: it is purely
              decorative, nothing it shows is information, only depth. */}
            <Reveal step={1} className="relative mx-auto mt-10 max-w-3xl">
              <div
                aria-hidden
                className="bg-card ring-foreground/6 absolute shadow-[0_1px_2px_rgb(15_23_42/0.08),0_14px_32px_-12px_rgb(15_23_42/0.2)] -inset-x-3 -top-3 bottom-3 -z-10 rotate-[-1.5deg] rounded-[28px] ring-1 sm:-inset-x-4"
              />
              <div className="bg-muted rounded-[28px] p-3 shadow-[0_2px_4px_rgb(15_23_42/0.1),0_18px_40px_-10px_rgb(15_23_42/0.22),0_48px_100px_-28px_rgb(15_23_42/0.3)] sm:p-4">
                <LandingAuctionDemo />
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 5.
          Trust. Stated as a benefit, not a mechanism — no ledger
          explanation here. The three custody facts that used to sit in the
          hero as a trust strip belong here instead, where the section is
          actually about trust.

          This was the fourth of six sections built as plain centered text —
          exactly the "stack identical centered blocks" pattern CLAUDE.md's
          §5 names directly. Split into two columns instead: the claim on the
          left, and a small provenance diagram on the right that actually
          shows what "carries its own history" means — mint, a hold, a
          resale, a check-in, each a real stage a ticket moves through, not a
          decorative sparkline standing in for content. */}
      <section>
        <div className="mx-auto max-w-4xl px-4">
          <div className="grid items-center gap-10 sm:grid-cols-[1.1fr_1fr] sm:gap-14">
            <Reveal className="text-center sm:text-left">
              <h2 className="text-foreground text-3xl leading-snug font-semibold tracking-tight text-balance sm:text-4xl">
                Ownership you can verify.
              </h2>
              <p className="text-muted-foreground mx-auto mt-3 max-w-md text-base leading-relaxed text-pretty sm:mx-0">
                Every ticket carries its own history — who&rsquo;s held it, and when — so a
                screenshot can never stand in for the real thing.
              </p>
            </Reveal>
            <Reveal step={1} className="mx-auto w-full max-w-[240px] sm:mx-0">
              <div aria-hidden className={`${CARD_SURFACE} rounded-2xl p-6`}>
                {PROVENANCE.map((step, i) => (
                  <div key={step} className="relative flex items-center gap-3 pb-7 last:pb-0">
                    {i < PROVENANCE.length - 1 && (
                      <span className="bg-border absolute top-3 left-[5px] h-full w-px" />
                    )}
                    <span
                      className="relative z-10 size-2.5 shrink-0 rounded-full"
                      style={{
                        background:
                          i === 0 || i === PROVENANCE.length - 1
                            ? 'var(--accent)'
                            : 'var(--color-border)',
                      }}
                    />
                    <span className="text-foreground text-sm font-medium">{step}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 6.
          Final CTA. Organizer-focused and deliberately calm — one button,
          not a competing pair, and the proof line folded in underneath
          rather than given its own section. */}
      <section>
        <div className="mx-auto max-w-4xl px-4">
          <Reveal>
            {/* The INK tier. A deep navy panel in BOTH themes — the one place the
            page goes dark on purpose — so the page closes on its strongest
            contrast instead of fading out into the footer. */}
            <div
              className="overflow-hidden rounded-[32px] bg-[#0d1a2b] px-6 py-14 text-center text-white shadow-[0_24px_60px_-24px_rgb(13_26_43/0.55)] ring-1 ring-white/10 sm:px-12 sm:py-16"
              style={{
                backgroundImage:
                  'radial-gradient(70% 90% at 50% 0%, color-mix(in oklch, var(--accent) 30%, transparent), transparent 70%)',
              }}
            >
              <h2 className="text-3xl leading-snug font-semibold tracking-tight text-balance text-white sm:text-4xl">
                Building an event?
              </h2>
              <p className="mx-auto mt-3 max-w-md text-base leading-relaxed text-pretty text-white/75">
                We&rsquo;re opening a small number of organizer pilots for a more flexible approach
                to ticketing and resale.
              </p>
              <div className="mt-8 flex justify-center">
                <Button
                  asChild
                  size="lg"
                  className="h-12 rounded-full bg-white px-7 text-[0.95rem] text-[#0d1a2b] transition-transform duration-200 hover:-translate-y-0.5 hover:bg-white/90 hover:shadow-lg"
                >
                  <a href="#hero-signin">Sign in to apply</a>
                </Button>
              </div>
              <p className="mx-auto mt-6 max-w-sm text-sm leading-relaxed text-white/75">
                Built and tested through a full mainnet rehearsal — real tickets, real settlement.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      <p className="text-muted-foreground text-center text-xs">{liveOn(network)}</p>
    </div>
  )
}
