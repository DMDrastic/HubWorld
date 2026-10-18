/**
 * A sticky phone that changes screen as the visitor scrolls past five short
 * steps — the same "scroll past a device mockup" pattern Mafin's landing page
 * uses, in HubWorld's own shape: five real moments in the app rather than an
 * abstract feature list.
 *
 * No scroll library. An IntersectionObserver watches a thin band at the
 * vertical centre of the viewport (`rootMargin: '-45% 0px -45% 0px'`) — the
 * step whose block is crossing that line becomes "active," which is the
 * standard scrollytelling trick and needs nothing heavier than what the
 * browser already gives for free.
 *
 * A two-column `grid` at every width, not just `lg:` — this is back after a
 * detour. Four attempts, in order:
 *
 * - `lg:sticky` (not sticky below `lg:`): no scroll effect on mobile at all.
 * - `flex-col` below `lg:`, phone full-width on top, steps stacked below:
 *   sticky worked, but the full-width phone sat on top of the steps' normal
 *   document flow, so the step TEXT scrolled visibly underneath it — "the
 *   background goes behind the phone."
 * - A two-column `grid`, but the phone column was ~35% — no more overlap,
 *   but squeezed to ~140px wide on a 390px screen it read as "small and
 *   weird."
 * - Hiding the five step blocks below `lg:` and showing one caption under
 *   the phone instead, so the phone could be full width again: fixed the
 *   sizing, but only one description was ever visible at a time, which
 *   read as out of sync with how desktop shows the whole list — you had to
 *   scroll the entire way through before you'd seen all five.
 *
 * Grid, with the SAME phone-and-list side by side as desktop, is correct —
 * the ~35% split was just tuned wrong. The phone column widens close to
 * desktop's split by `lg:`; below that it's deliberately phone-forward
 * (~55-58%) rather than an even split, because the device is the thing
 * worth seeing clearly and the step text only has to be readable in a
 * narrow column, not comfortable — smaller type than the `lg:` column uses,
 * same as the rest of this trade-off.
 *
 * The "01…05" step numbers read `var(--accent)` (declared by `Landing.tsx`
 * on the subtree this mounts into) rather than `--primary`. The phone-screen
 * mockups themselves — `TicketScreen`, `GiftScreen`, `AuctionScreen`,
 * `CapScreen`, `DoorScreen` — deliberately keep `--primary` (violet)
 * untouched: they reproduce real in-app UI, and recoloring a reproduction of
 * the shipped app would make it lie about what the app actually looks like.
 * Only the marketing chrome around the phone picks up the new accent.
 *
 * STEP COPY (2026-10 product-first pass). Titles and bodies were rewritten to
 * drop ledger language ("XRPL NFT," "buy offer on the ledger," "signs with
 * their own key") in favour of the benefit each step actually delivers — see
 * `Landing.tsx`'s own file-top comment for why: the product is the pitch,
 * the ledger is the machinery underneath it. The step TITLES render in the
 * page's one body face (Geist) like everything else on this page — an
 * earlier pass gave them a second display face via `--font-display`; that
 * token no longer exists (Fraunces was removed), so this reverts to the
 * single-typeface system the rest of the page already uses.
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import iphoneFrame from '@/assets/iphone-17-pro-cosmic-orange-portrait.png'

function demoHue(slug: string): number {
  let h = 5381
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0
  // Mapped into a 140°-wide teal-through-violet band rather than the full
  // wheel. The unconstrained `% 360` is what let this land on rust/brown for
  // 'skyline-sessions' — the one warm hue on an otherwise cool-toned page,
  // reading as an unstyled accident rather than a choice. Still procedural
  // per slug (not a single hardcoded value), just fenced to hues that are
  // actually brand-adjacent.
  return 160 + (Math.abs(h) * 137.508) % 140
}

type ScreenId = 'ticket' | 'gift' | 'auction' | 'cap' | 'door'

const STEPS: { eyebrow: string; title: string; body: string; screen: ScreenId }[] = [
  {
    eyebrow: '01',
    title: 'Yours the moment you buy it',
    // "nobody can revoke it" is a verified claim, not marketing language:
    // `buildMintTx` in the backend mints with `TF_TRANSFERABLE | TF_MUTABLE`
    // only — no `tfBurnable` — so neither HubWorld nor the organizer has any
    // on-ledger way to seize or destroy a ticket once it's issued.
    body: "Every ticket lands directly in your account. We can show it to you — but we can't take it back, and neither can anyone else.",
    screen: 'ticket',
  },
  {
    eyebrow: '02',
    title: 'Send it to a friend, free',
    body: 'A couple of taps. No fee, no re-issuing — just send it to someone else.',
    screen: 'gift',
  },
  {
    eyebrow: '03',
    title: 'Watch the price climb, live',
    body: 'Real bids move the price. Follow the auction as it unfolds.',
    screen: 'auction',
  },
  {
    eyebrow: '04',
    title: 'Scalpers hit a real ceiling',
    // The enforcement clause is scoped to "through HubWorld" deliberately —
    // `checkResalePrice` (src/resale-policy.ts, backend) is real and
    // enforced server-side on listings, bids, and auction-open, but it has
    // no power over a private sale made outside the app, and the claim
    // should not imply otherwise.
    body: 'Organizers can cap resale at face value, a percentage limit, or a fixed ceiling — or leave it unrestricted. Every resale through HubWorld follows the rule they set.',
    screen: 'cap',
  },
  {
    eyebrow: '05',
    title: "A screenshot can't get you in",
    // Precision matters here: nothing is technically "presented" and
    // scanned at the door. The attendee's own device signs a challenge, and
    // that signature is checked against who currently holds the ticket
    // on-ledger — a photo has no key behind it to sign with.
    body: "At the door, you prove it's really you — a live signature, checked against who actually holds the ticket right now. A screenshot has nothing behind it to sign with.",
    screen: 'door',
  },
]

/**
 * A rooftop skyline at dusk, standing in for an uploaded event photo —
 * illustrated rather than a stock photo, matching the restrained, abstract
 * treatment `EventPoster`'s own fallback already uses for events with no
 * artwork, rather than introducing the first photographic asset in the app.
 * Pure SVG shapes computed from the slug's hue, so it never needs a network
 * request and stays perfectly crisp at any phone-frame size.
 */
function SkylineArt({ hue }: { hue: number }) {
  const silhouette = `oklch(0.16 0.04 ${(hue + 20) % 360})`
  const buildings = [
    { x: 0, w: 16, h: 22 },
    { x: 15, w: 11, h: 34 },
    { x: 25, w: 14, h: 26 },
    { x: 38, w: 10, h: 40 },
    { x: 47, w: 16, h: 30 },
    { x: 62, w: 12, h: 38 },
    { x: 73, w: 15, h: 24 },
    { x: 87, w: 13, h: 32 },
  ]
  return (
    // `meet`, not `slice`: the ticket art area's real height varies with
    // the phone frame's own rendered size, so "cover" cropping zoomed into
    // a single building at some sizes. `meet` scales the WHOLE scene to fit
    // and anchors it to the bottom — any extra space lands above the
    // skyline as more sky, which the gradient already fills, so there is
    // never a visible crop or letterbox bar.
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMax meet"
      className="absolute inset-0 size-full"
      aria-hidden
    >
      <circle cx="78" cy="20" r="7" fill="white" fillOpacity="0.2" />
      {[
        [10, 14],
        [25, 8],
        [42, 18],
        [60, 10],
        [92, 16],
        [18, 28],
        [52, 6],
        [70, 30],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="0.8" fill="white" fillOpacity="0.5" />
      ))}
      {buildings.map((b, i) => (
        <rect key={i} x={b.x} y={100 - b.h} width={b.w} height={b.h} fill={silhouette} />
      ))}
      {/* The observatory dome the venue name promises, on the tallest
          building, with a thin telescope line angled up from it. */}
      <circle cx="43" cy="62" r="6" fill={silhouette} />
      <line x1="43" y1="62" x2="52" y2="50" stroke={silhouette} strokeWidth="1.6" strokeLinecap="round" />
      {/* A string of warm rooftop lights — the one warm accent against the
          cool dusk gradient and the dark silhouettes. */}
      {[8, 20, 32, 44, 56, 68, 80, 92].map((x, i) => (
        <circle key={i} cx={x} cy="97" r="1.1" fill="oklch(0.78 0.14 70)" fillOpacity="0.85" />
      ))}
    </svg>
  )
}

function TicketScreen() {
  const slug = 'skyline-sessions'
  const hue = demoHue(slug)
  return (
    <div className="flex h-full flex-col">
      <div
        className="relative flex flex-1 flex-col justify-end overflow-hidden p-4"
        style={{
          background: `linear-gradient(160deg,
            oklch(0.40 0.105 ${hue}) 0%,
            oklch(0.24 0.075 ${(hue + 25) % 360}) 58%,
            oklch(0.16 0.045 ${(hue + 45) % 360}) 100%)`,
        }}
      >
        <SkylineArt hue={hue} />
        {/* Same technique `EventPoster` uses over a real photo: a scrim so
            the title stays legible regardless of what the art behind it
            looks like, rather than tuning the art to dodge the text. */}
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/75 to-transparent" />
        <div className="relative font-heading text-lg leading-tight font-semibold tracking-[-0.02em] text-white">
          Skyline Sessions
        </div>
        <div className="relative mt-1 font-mono text-[0.6rem] tracking-[0.18em] text-white/60 uppercase">
          The Observatory, Rooftop
        </div>
      </div>
      <div className="bg-card space-y-2.5 p-4 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Held by</span>
          <span className="font-mono">@arin_k</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Token</span>
          <span className="font-mono">000861…A42F</span>
        </div>
        <span className="bg-live/10 text-live border-live/25 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium">
          not yet redeemed
        </span>
      </div>
    </div>
  )
}

function GiftScreen() {
  return (
    <div className="flex h-full flex-col justify-center p-5 text-center">
      <div className="text-foreground text-sm font-medium">Gift a ticket</div>
      <div className="text-muted-foreground mt-1 text-xs">
        Free peer-to-peer. Two signatures — you offer it, they accept it.
      </div>
      <div className="bg-muted mt-5 rounded-xl p-4">
        <div className="text-muted-foreground text-[0.65rem]">Gift to</div>
        <div className="mt-0.5 font-mono text-sm">@mina_v</div>
        <span className="bg-primary/10 text-primary border-primary/25 mt-3 inline-flex items-center rounded-full border px-2.5 py-1 text-[0.65rem] font-medium">
          offered
        </span>
      </div>
      <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
        Offer is live on-ledger. @mina_v can now accept.
      </p>
    </div>
  )
}

function AuctionScreen() {
  const points = '0,38 10,38 10,30 30,30 30,20 55,20 55,6 90,6'
  return (
    <div className="flex h-full flex-col justify-center p-5">
      <div className="text-muted-foreground font-mono text-[0.65rem] tracking-[0.14em] uppercase">
        Leading bid
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-3xl font-semibold tabular-nums">13.00</span>
        <span className="text-muted-foreground text-xs font-medium">XRP</span>
      </div>
      <div className="text-muted-foreground mt-1 text-xs">@mina_v · just now</div>
      <svg viewBox="0 0 90 44" className="mt-5 h-16 w-full" preserveAspectRatio="none" aria-hidden>
        <polyline
          points={points}
          fill="none"
          stroke="var(--color-chart-1)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="mt-4 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Reserve</span>
        <span className="text-live font-mono">met</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Bids</span>
        <span className="font-mono">4 / 3 bidders</span>
      </div>
    </div>
  )
}

function CapScreen() {
  return (
    <div className="flex h-full flex-col justify-center p-5">
      <div className="text-muted-foreground mb-3 text-xs">
        Cap is 150% of face value (12.00 XRP)
      </div>
      <div className="flex items-center gap-2">
        <div className="border-input bg-muted text-muted-foreground flex-1 rounded-lg border px-3 py-2 font-mono text-sm">
          15
        </div>
        <span className="bg-primary text-primary-foreground rounded-lg px-3.5 py-2 text-sm font-medium">
          List
        </span>
      </div>
      <p className="text-destructive mt-3 text-xs leading-relaxed">
        This event&rsquo;s organizer has limited resale prices to 12 XRP.
      </p>
    </div>
  )
}

function DoorScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-5 text-center">
      <div className="bg-live/10 text-live flex size-14 items-center justify-center rounded-full">
        <CheckCircle2 className="size-7" aria-hidden />
      </div>
      <div className="text-live mt-4 text-lg font-semibold">Admitted</div>
      <div className="text-muted-foreground mt-1 text-xs">Valid ticket, checked in.</div>
      <div className="mt-3 font-mono text-xs">@arin_k</div>
    </div>
  )
}

const SCREENS: Record<ScreenId, () => React.JSX.Element> = {
  ticket: TicketScreen,
  gift: GiftScreen,
  auction: AuctionScreen,
  cap: CapScreen,
  door: DoorScreen,
}

/**
 * The real bezel: Apple's own "iPhone 17 Pro — Cosmic Orange — Portrait"
 * product-bezel asset (developer.apple.com/design/resources — Product
 * Bezels, free to use when showcasing an app), replacing the earlier
 * hand-drawn titanium/body div stack.
 *
 * Apple's source canvas (1350×2760) carries a transparent margin AROUND the
 * device silhouette (it doesn't touch the canvas edges) — harmless in
 * Apple's own tooling, but a visible hairline artifact here: the frame
 * `<img>` is scaled down for display, and that scaling left a faint but real
 * fringe exactly at the image's own rectangular bounding box, outside the
 * device's rounded silhouette — not inside the PNG's pixels (its alpha is
 * verified 0 at every edge pixel) but introduced by the browser compositing
 * a scaled image with transparent padding against the page behind it. The
 * fix is to remove the thing the artifact has to attach to: the asset is
 * cropped to the device's exact opaque bounding box (measured via the alpha
 * channel's `getbbox()`, not eyeballed) before being saved, so the `<img>`'s
 * own box edges coincide with the visible silhouette and there is no dead
 * margin left for anything to fringe.
 *
 * `SCREEN` below is the transparent "screen cutout" rectangle, measured the
 * same way, then re-expressed as a percentage of THIS cropped canvas (not
 * the original 1350×2760 one — cropping shifts the origin, so the original
 * measurement's raw pixel coordinates were offset by the crop before
 * converting to percentages):
 *   - left 4.249%, right 4.325%, top 7.324%, bottom 1.767% of the cropped
 *     880×1814 canvas.
 *   - corner radius: measured ~110px on a 1205×2470px screen rect (unchanged
 *     by the crop, since it's internal to the screen rect). A single
 *     percentage radius would reproduce the elongated-corner bug this file
 *     hit once already (percentage border-radius resolves independently
 *     against width and height) — so this uses CSS's `x% / y%` elliptical
 *     radius form instead: 110/1205 ≈ 9.13% horizontal, 110/2470 ≈ 4.45%
 *     vertical, which stays a true (non-egg-shaped) corner at any size.
 * The content layer renders BELOW the frame image (z-0 vs the image's
 * implicit stacking as the next sibling); the frame's own Dynamic-Island
 * and camera cutouts are baked into the PNG, so they composite over the
 * content for free instead of being redrawn by hand.
 */
const SCREEN = { left: 4.249, right: 4.325, top: 7.324, bottom: 1.767, radius: '9.13% / 4.45%' }

function PhoneFrame({ screen }: { screen: ScreenId }) {
  const Screen = SCREENS[screen]
  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div className="elevate relative aspect-[1318/2717]">
        <div
          /* `bg-card`, not `bg-background` — the screen sits inside a frame
             on a page whose own body is `bg-background`, so matching that
             token made the "lit screen" indistinguishable from a hole in
             the page in dark mode (card is reliably a shade lighter than
             background in both themes, which is also the direction a real
             backlit screen should read). */
          className="bg-card absolute z-0 overflow-hidden"
          style={{
            left: `${SCREEN.left}%`,
            right: `${SCREEN.right}%`,
            top: `${SCREEN.top}%`,
            bottom: `${SCREEN.bottom}%`,
            borderRadius: SCREEN.radius,
          }}
        >
          {/* Full-bleed, no safe-area padding. A padded gap here was tried
              first and reads WRONG rather than careful: it leaves bare
              `bg-card` exposed with nothing drawn on it, invisible on the
              dark-mode screens but a plain white seam under the island in
              light mode — any screen that paints its own background
              (`TicketScreen`'s photo) shows a hard edge where that background
              stops short of the frame's own edge. A real iOS screenshot has
              no such gap: content renders full-bleed under the island, which
              is a hardware cutout sitting ON TOP of the display, not a
              reserved blank strip. */}
          <div key={screen} className="screen-fade absolute inset-0">
            <Screen />
          </div>
          {/* A faint diagonal gloss, the way a glass screen catches light in
              product photography — purely decorative, so it's excluded from
              the fade/remount key and never competes with the content. */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, transparent 32%)',
            }}
            aria-hidden
          />
        </div>

        <img
          src={iphoneFrame}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none relative z-10 size-full select-none"
        />
      </div>
    </div>
  )
}

export function LandingPhoneShowcase() {
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    // Picking "active" from whichever single IntersectionObserver entry
    // happened to fire isIntersecting=true was order-dependent: with no gap
    // between step blocks, one block's bottom edge can cross out of the
    // centre band in the same callback batch as the next block's top edge
    // crossing in, and which of the two "wins" depended on array order, not
    // on which one is actually nearer the band — reproduced as the phone
    // showing the NEXT step's screen while the previous step's caption was
    // still the one on screen. Recomputing every block's actual distance
    // from the viewport's vertical centre on every firing removes the
    // ambiguity entirely: whichever block is geometrically closest wins,
    // regardless of which entries fired or in what order.
    const pickActive = () => {
      const mid = window.innerHeight / 2
      let bestIdx = -1
      let bestDist = Infinity
      refs.current.forEach((el, i) => {
        if (!el) return
        const rect = el.getBoundingClientRect()
        const dist = Math.abs(rect.top + rect.height / 2 - mid)
        if (dist < bestDist) {
          bestDist = dist
          bestIdx = i
        }
      })
      if (bestIdx !== -1) setActive(bestIdx)
    }

    const observer = new IntersectionObserver(pickActive, {
      rootMargin: '-45% 0px -45% 0px',
      threshold: 0,
    })
    refs.current.forEach((el) => el && observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <div className="grid grid-cols-[57%_1fr] items-start gap-3 sm:grid-cols-[45%_1fr] sm:gap-6 lg:grid-cols-[1fr_1.05fr] lg:gap-12">
      <div className="sticky top-16 lg:top-24">
        <PhoneFrame screen={STEPS[active]!.screen} />
      </div>

      <div className="space-y-0">
        {STEPS.map((s, i) => (
          <div
            key={s.title}
            ref={(el) => {
              refs.current[i] = el
            }}
            className="flex min-h-[42vh] flex-col justify-center py-6 sm:min-h-[55vh] lg:min-h-[65vh] lg:py-8"
          >
            <span className="font-mono text-xs tabular-nums text-[var(--accent)]/70">{s.eyebrow}</span>
            <h3 className="mt-2 max-w-md text-base leading-snug font-medium tracking-tight text-balance sm:text-xl lg:text-2xl">
              {s.title}
            </h3>
            <p className="text-muted-foreground mt-2.5 max-w-sm text-xs leading-relaxed text-pretty sm:mt-3 sm:text-sm">
              {s.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
