/**
 * The signed-out landing page.
 *
 * Written for ONE visitor: an organizer arriving cold, from a conversation or a
 * post, who runs events and has never heard of HubWorld. Attendees do not land
 * here in any number — they follow an organizer's link to an event — so the page
 * does not try to serve them beyond a quiet link to Events.
 *
 * ## The first screen is a verdict
 *
 * The opening is the moment at the door when a ticket works: a full-width green
 * "Admitted" with the guest's handle, and under it the two other answers a door
 * can give. It is labelled as an example, because it is one. It opens on the
 * door rather than on a pitch because it shows something only this product can
 * show, a ticket checked against the ledger and answered in one word, and
 * because the headline beneath it then has something to be about.
 *
 * The category default this refuses is a centred headline over two buttons and
 * a row of identical cards. Sections are left-aligned on one grid; the royalty
 * claim sits beside its proof instead of above three boxes.
 *
 * ## Proof, and only proof
 *
 * Two real measurements appear: the split of one resale settled on mainnet, and
 * the 1,000-ticket run that one organizer signature produced. Everything else a
 * visitor sees that looks like data (the door verdict, the auction demo) is
 * labelled as an example. No testimonial, customer or usage figure appears
 * because none exists.
 *
 * ## What is deliberately unchanged
 *
 * `LandingPhoneShowcase` (the sticky iPhone walk-through) and `LandingAuctionDemo`
 * are not edited. They read `--accent`, which this wrapper sets to the app's
 * action violet, so their chrome follows the rest of the page.
 *
 * ## Two constraints the tests pin
 *
 * **Full bleed.** `App.tsx` mounts this inside `max-w-6xl`, so the wrapper
 * escapes it with `w-screen` and a negative margin; every section re-centres its
 * own content.
 *
 * **No overflow rule anywhere above the phone.** `overflow-x-clip` here once made
 * WebKit track the sticky phone against this wrapper instead of the page, so on
 * an iPhone it lagged the pinned header and bumped it while a finger was moving.
 * Headless engines cannot show that. Horizontal clipping lives on `body` from
 * `sm:` up (see index.css), and `Landing.test.tsx` pins both halves.
 *
 * XRPL is named once, in the quiet closing line, and the network claim there is
 * never a guess: see `liveOn`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, Link2, SlidersHorizontal, TrendingUp } from 'lucide-react'
// Crowd under stage lights, by Marcel Strauss (Unsplash licence), cropped to
// 1920x900 from the original and recompressed. Provenance: file
// `marcel-strauss-ubwn8GI9-2o-unsplash.jpg`, supplied by the project owner.
import stageLights from '@/assets/landing-stage-lights.jpg'
import { PageBackdrop } from '@/components/PageBackdrop'
import { SignIn } from '@/components/SignIn'
import { EmailSignIn } from '@/components/EmailSignIn'
import { LandingAuctionDemo } from '@/components/LandingAuctionDemo'
import { LandingCreateDemo } from '@/components/LandingCreateDemo'
import { LandingPhoneShowcase } from '@/components/LandingPhoneShowcase'
import { LandingPosterCloud } from '@/components/LandingPosterCloud'
import type { AuthUser, EventSummary, Health } from '@/lib/api'
import { useLinkHandler } from '@/lib/router'

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
 * Scroll reveal, the ONE entrance used below the hero: opacity and a 20px rise,
 * the same duration and exponential ease-out everywhere, staggered by at most
 * three 90ms steps within a block. Same distance and curve on every unit is
 * what makes it one rhythm instead of per-element effects.
 *
 * Nothing is ever hidden when it cannot be revealed: reduced motion, or no
 * IntersectionObserver (jsdom, very old browsers), start out shown. Anything
 * already above the viewport (anchor jump, restored scroll) is revealed too,
 * since it will never intersect again.
 */
function useRevealed(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
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
        if (entries.some((e) => e.isIntersecting || e.boundingClientRect.top < 0)) {
          setShown(true)
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    )
    io.observe(el)
    // IntersectionObserver reports crossings, so a jump that skips a unit
    // entirely (anchor link, scrollbar drag) never fires for it. This passive
    // listener catches that one case: the unit is already behind us.
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

const LIFECYCLE = ['Buy', 'Gift', 'Resell', 'Auction', 'Check in'] as const

/** The trust section's provenance diagram — real stages, not decoration. */
const PROVENANCE = ['Minted', 'Held', 'Resold', 'Checked in'] as const

/**
 * The royalty ceiling is `MAX_ROYALTY_BPS`'s default (2000 bps,
 * backend/src/env.ts) stated as a percentage: a real platform default, not a
 * made-up figure, so it earns the label beside the claim it limits.
 */
const ORGANIZER_VALUE = [
  {
    title: 'Earn from resale',
    body: 'Set your own royalty on every resale. It is paid automatically, so there is nothing to chase after the fact.',
    note: 'Up to 20%',
    icon: TrendingUp,
  },
  {
    title: 'Control resale',
    body: 'Cap resale at a percentage of face value, a fixed price, or turn it off entirely. Your event, your rules.',
    note: null,
    icon: SlidersHorizontal,
  },
  {
    title: 'Stay connected',
    body: 'Primary sales, resale, auctions and check-in stay part of one system, not four disconnected tools.',
    note: null,
    icon: Link2,
  },
] as const

/** One verdict a door can give, shown quietly under the live one. */
function QuietVerdict({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="surface flex flex-1 items-center justify-between gap-4 px-5 py-4">
      <span className="font-semibold tracking-tight whitespace-nowrap">{title}</span>
      <span className="text-muted-foreground text-right text-sm">{hint}</span>
    </div>
  )
}

export function Landing({
  onAuthenticated,
  network,
  events = [],
}: {
  onAuthenticated: (u: AuthUser) => void
  /** From /api/health. Undefined until it loads, or on an API too old to say. */
  network?: Health['network']
  /** The events on HubWorld now, for the poster cloud. Empty shows no cloud. */
  events?: EventSummary[]
}) {
  const link = useLinkHandler()

  return (
    <PageBackdrop className="mx-[calc(50%-50vw)] w-screen space-y-20 pb-16 sm:space-y-24">

      {/* ------------------------------------------------------------- 1.
          The offer, and the events it is for. Headline first, as a stranger reads
          it, in the owner's own words, with the closing phrase in warm gradient text
          (a deliberate exception; see `.warm-text` in index.css) and the royalty, the
          commercial hook, named in the supporting line. Around it float posters: the
          real events with artwork come first, then decorative artwork fills the
          remaining places (see LandingPosterCloud). `animate-in` plays once on mount: the
          page's one orchestrated moment, and reduced motion is handled by
          index.css's global rule. */}
      <section className="!mt-0 pt-8 sm:pt-12">
        <div className="relative mx-auto max-w-[1280px] px-4">
          <LandingPosterCloud events={events} />

          <div className="animate-in fade-in slide-in-from-bottom-3 relative mx-auto max-w-2xl text-center duration-700 ease-out xl:py-24">
            <h1 className="text-4xl leading-[1.04] font-semibold tracking-[-0.035em] text-balance sm:text-5xl lg:text-6xl">
              Every ticket you hold, <span className="warm-text">in one hub.</span>
            </h1>
            <p className="text-muted-foreground mx-auto mt-5 max-w-xl text-lg leading-relaxed text-pretty">
              Buy, gift, resell and check in — all from one place, while organizers stay connected to
              what happens after the first sale, and{' '}
              <span className="text-foreground font-medium">earn a royalty on every resale</span>.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
              {/* `SignIn` always renders inside a `Card`; the `data-slot` hooks
                  (its documented extension point) collapse that chrome down to
                  a bare pill for the idle state. This is the ONE live `SignIn`
                  on the page; the other calls to action anchor back to it
                  rather than mounting a second. */}
              <div
                id="hero-signin"
                className="[&_[data-slot=card-content]]:p-0 [&_[data-slot=card-header]]:hidden [&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:p-0 [&_[data-slot=card]]:shadow-none [&_[data-slot=card]]:ring-0 [&_[data-slot=card]]:border-0"
              >
                <SignIn
                  onAuthenticated={onAuthenticated}
                  primaryButtonLabel="Explore the HubWorld"
                  primaryButtonClassName="h-11 rounded-full bg-primary px-6 text-[0.95rem] text-primary-foreground transition-opacity hover:bg-primary hover:opacity-90"
                />
              </div>
              <a
                href="/events"
                onClick={link('/events')}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded text-[0.95rem] underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                See events
              </a>
            </div>
            {/* No app to install: an email makes the wallet. Draws nothing unless the deployment offers it. */}
            <div className="mx-auto mt-6 max-w-sm text-left">
              <EmailSignIn onAuthenticated={onAuthenticated} />
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 2.
          The door. The previous page opened here; it is now the second beat, once
          the visitor knows what they are looking at. A verdict at full width, an
          example labelled as one, and the two other answers a door can give. */}
      <section id="door" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal className="mb-8 max-w-xl">
            <h2 className="text-3xl leading-snug font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
              Every ticket answers at the door.
            </h2>
            <p className="text-muted-foreground mt-3 leading-relaxed text-pretty">
              Staff see one word, checked against the ledger a moment ago, and a duplicate is told
              apart from a stranger.
            </p>
          </Reveal>

          {/* The verdict sits on a photograph of a crowd under stage lights
              instead of a flat field. Text is always white (the photo is dark
              blue in both themes) over a flat 50% black layer, never a
              gradient, so the lightest haze in the middle of the picture still
              clears contrast. The green is a dot on the label and a check beside
              the handle: state still needs a colour AND a word, and the word is
              "Admitted". */}
          <div
            role="img"
            aria-label="Example of a door check-in: admitted, guest @jordan_k, Neon Rooftop Session, general admission, checked against the ledger."
            className="relative isolate flex flex-col justify-between gap-10 overflow-hidden rounded-3xl p-6 text-white sm:p-10 lg:min-h-[26rem] lg:p-14"
          >
            <img
              src={stageLights}
              alt=""
              aria-hidden
              decoding="async"
              className="absolute inset-0 -z-20 size-full object-cover object-[50%_55%]"
            />
            <div aria-hidden className="absolute inset-0 -z-10 bg-black/50" />
            <p aria-hidden className="flex items-center gap-2.5 font-mono text-sm text-white/85">
              <span className="bg-live size-2.5 rounded-full" />
              Door check-in
            </p>
            <div aria-hidden className="grid gap-8 lg:grid-cols-[1fr_20rem] lg:items-end">
              <p className="text-[clamp(3.25rem,10vw,6rem)] leading-[0.95] font-semibold tracking-[-0.04em]">
                Admitted
              </p>
              <div>
                <p className="flex items-center gap-2.5 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                  <CircleCheck className="text-live size-7 shrink-0 sm:size-8" strokeWidth={2.25} />
                  @jordan_k
                </p>
                <p className="mt-1.5 text-lg text-white/85">
                  Neon Rooftop Session
                  <br />
                  General admission, checked against the ledger
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-4 sm:flex-row">
            <QuietVerdict title="Already checked in" hint="a duplicate, not a stranger" />
            <QuietVerdict title="No ticket" hint="a stranger, not a duplicate" />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 3.
          Start with the poster. The create page's best moment, shown as something
          to do: pick a sample poster and the plate takes on its colour. */}
      <section id="create" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal className="mb-8 max-w-xl">
            <h2 className="text-3xl leading-snug font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
              Start with the poster.
            </h2>
            <p className="text-muted-foreground mt-3 leading-relaxed text-pretty">
              Add one and the page takes on its colour. Then set a price, a royalty, and how high a
              ticket may resell. That is the whole form.
            </p>
          </Reveal>
          <Reveal step={1}>
            <LandingCreateDemo />
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------- 2.
          Lifecycle. The phone-scroll showcase, untouched — see
          LandingPhoneShowcase.tsx for the real-iPhone frame and the step copy.
          The one-line strip above it is the same lifecycle stated in five words
          for anyone who does not scroll further. */}
      <section id="lifecycle" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl space-y-10 px-4">
          <div className="max-w-xl">
            <h2 className="text-3xl leading-snug font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
              One ticket, start to finish.
            </h2>
            <p className="text-muted-foreground mt-3 leading-relaxed text-pretty">
              Buy it, gift it, resell it, or bid on it, then walk in with a scan. Every step is
              verifiable, without you ever having to think about how.
            </p>
            <div className="text-muted-foreground mt-5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm font-medium">
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
          Organizer value. The three claims are a short list, not three boxes. */}
      <section id="organizers" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal>
            <h2 className="max-w-xl text-3xl leading-snug font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
              Built for organizers who want a say in what happens next.
            </h2>
            <p className="text-muted-foreground mt-3 max-w-lg leading-relaxed text-pretty">
              Primary sales are only the start. HubWorld keeps you connected to every resale after.
            </p>
            <ul className="mt-10 divide-y border-y">
              {ORGANIZER_VALUE.map((c) => (
                <li key={c.title} className="flex gap-4 py-6">
                  <c.icon aria-hidden className="text-muted-foreground mt-0.5 size-5 shrink-0" strokeWidth={1.75} />
                  <div>
                    <h3 className="flex flex-wrap items-baseline gap-x-3 font-semibold tracking-tight">
                      {c.title}
                      {c.note && (
                        <span className="text-muted-foreground font-mono text-xs font-normal">
                          {c.note}
                        </span>
                      )}
                    </h3>
                    <p className="text-muted-foreground mt-1.5 max-w-md text-sm leading-relaxed text-pretty">
                      {c.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------- 4.
          Secondary market. The auction demo, in a plate of its own, labelled as a
          demonstration so nobody reads its bids as a result. */}
      <section>
        <div className="mx-auto max-w-6xl px-4">
          {/* RESTORED: the recessed panel the demo sits on, and the second, inert
              card tilted behind it. The back card needs `-z-10`, not just DOM
              order: the live card is a static-position div, and a static sibling
              paints ABOVE an absolutely-positioned one of equal z-index
              regardless of source order. `aria-hidden` throughout: it is depth,
              not information. */}
          <div className="rounded-[32px] border border-foreground/[0.08] bg-[var(--panel)] px-4 py-12 shadow-[inset_0_1px_0_rgb(255_255_255/0.5)] sm:px-10 sm:py-16 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
            <Reveal className="mx-auto max-w-xl text-center">
              <h2 className="text-3xl leading-snug font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
                A secondary market you&rsquo;re actually part of.
              </h2>
              <p className="text-muted-foreground mt-3 leading-relaxed text-pretty">
                Tickets can be resold at a fixed price or bid on in a live auction, and your resale
                rules and royalty travel with every sale, automatically.
              </p>
            </Reveal>
            <Reveal step={1} className="relative mx-auto mt-10 max-w-3xl">
              <div
                aria-hidden
                className="bg-card ring-foreground/6 absolute shadow-[0_1px_2px_rgb(15_23_42/0.08),0_14px_32px_-12px_rgb(15_23_42/0.2)] -inset-x-3 -top-3 bottom-3 -z-10 rotate-[-1.5deg] rounded-[28px] ring-1 sm:-inset-x-4"
              />
              <div className="bg-muted rounded-[28px] p-3 shadow-[0_2px_4px_rgb(15_23_42/0.1),0_18px_40px_-10px_rgb(15_23_42/0.22),0_48px_100px_-28px_rgb(15_23_42/0.3)] sm:p-4">
                <LandingAuctionDemo />
              </div>
            </Reveal>
            <p className="text-muted-foreground mx-auto mt-6 max-w-3xl text-xs">
              A demonstration. The bids and prices are synthetic.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 5.
          Trust, stated as a benefit and not a mechanism, beside a small
          provenance diagram of real stages a ticket moves through. */}
      <section>
        <div className="mx-auto max-w-6xl px-4">
          <div className="grid items-center gap-10 sm:grid-cols-[1.1fr_1fr] sm:gap-14 lg:grid-cols-[1.4fr_1fr]">
            <Reveal>
              <h2 className="max-w-lg text-3xl leading-snug font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
                Ownership you can verify.
              </h2>
              <p className="text-muted-foreground mt-3 max-w-md leading-relaxed text-pretty">
                Every ticket carries its own history, who has held it and when, so a screenshot can
                never stand in for the real thing.
              </p>
            </Reveal>
            <Reveal step={1} className="w-full max-w-[240px]">
              <div aria-hidden className="surface p-6">
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
                    <span className="text-sm font-medium">{step}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 6.
          Final call to action. One button, and the second real proof folded in
          underneath rather than given a section of its own. */}
      <section>
        <div className="mx-auto max-w-6xl px-4">
          <Reveal>
            {/* RESTORED: the INK tier. A deep navy panel in BOTH themes, the one
                place the page goes dark on purpose, so it closes on its strongest
                contrast instead of fading into the footer. */}
            <div
              className="overflow-hidden rounded-[32px] bg-[#0d1a2b] px-6 py-14 text-center text-white shadow-[0_24px_60px_-24px_rgb(13_26_43/0.55)] ring-1 ring-white/10 sm:px-12 sm:py-16"
              style={{
                backgroundImage:
                  'radial-gradient(70% 90% at 50% 0%, color-mix(in oklch, var(--accent) 30%, transparent), transparent 70%)',
              }}
            >
              <h2 className="text-3xl leading-snug font-semibold tracking-[-0.025em] text-balance text-white sm:text-4xl">
                Building an event?
              </h2>
              <p className="mx-auto mt-3 max-w-md leading-relaxed text-pretty text-white/75">
                We&rsquo;re opening a small number of organizer pilots for a more flexible approach
                to ticketing and resale.
              </p>
              <div className="mt-8 flex justify-center">
                <a
                  href="#hero-signin"
                  className="focus-visible:ring-ring inline-flex h-11 items-center rounded-full bg-white px-6 text-[0.95rem] font-medium text-[#0d1a2b] transition-transform duration-200 hover:-translate-y-0.5 hover:bg-white/90 hover:shadow-lg focus-visible:ring-2 focus-visible:outline-none"
                >
                  Sign in to apply
                </a>
              </div>
              <p className="mx-auto mt-6 max-w-sm text-sm leading-relaxed text-white/75">
                One organizer signature minted 1,000 tickets on the XRP Ledger mainnet in 736
                seconds on 20 October 2026, each one issued by the organizer&rsquo;s own account.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      <p className="text-muted-foreground text-center text-xs">{liveOn(network)}</p>
    </PageBackdrop>
  )
}
