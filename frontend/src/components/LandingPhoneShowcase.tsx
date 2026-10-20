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
 * The "01…05" step numbers and the progress rail beside the step list both
 * read `var(--accent)` (declared by `Landing.tsx` on the subtree this mounts
 * into) rather than `--primary`. The phone-screen
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
import { chooseActiveStep } from '@/lib/active-step'

type ScreenId = 'ticket' | 'gift' | 'auction' | 'cap' | 'door'

const STEPS: { title: string; body: string; screen: ScreenId }[] = [
  {
    title: 'Yours the moment you buy it',
    // "nobody can revoke it" is a verified claim, not marketing language:
    // `buildMintTx` in the backend mints with `TF_TRANSFERABLE | TF_MUTABLE`
    // only — no `tfBurnable` — so neither HubWorld nor the organizer has any
    // on-ledger way to seize or destroy a ticket once it's issued.
    body: "Every ticket lands directly in your account. We can show it to you — but we can't take it back, and neither can anyone else.",
    screen: 'ticket',
  },
  {
    title: 'Send it to a friend, free',
    body: 'A couple of taps. No fee, no re-issuing — just send it to someone else.',
    screen: 'gift',
  },
  {
    title: 'Watch the price climb, live',
    body: 'Real bids move the price. Follow the auction as it unfolds.',
    screen: 'auction',
  },
  {
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
 * The event picture on the ticket screen: a vaporwave sunset, standing in for an
 * uploaded event photo. Illustrated rather than a stock photo, so it never needs
 * a network request and stays crisp at any phone-frame size.
 *
 * It FILLS the screen. The first version drew a skyline with `meet` scaling,
 * anchored to the bottom, so any height the picture area had beyond the scene's
 * own aspect ratio showed the gradient behind it as a band across the top, which
 * read as the page's colour and not as part of the picture. `slice` scales the
 * scene to cover the box and crops the overflow instead, so there is never a gap;
 * the composition is centred, with the sun and horizon placed so a crop of either
 * axis loses only sky or floor, never the subject.
 *
 * The magenta, cyan and violet here are the point of the style, and the project's
 * own design notes ban purple-and-pink gradients for UI. They are kept to this one
 * illustration inside a phone, at the owner's request, and nothing on the page
 * itself uses them.
 */
function VaporwaveArt() {
  // Perspective grid: horizontal lines bunch up toward the horizon (y = 92) the way
  // a receding floor does, and the verticals all run to one vanishing point.
  const horizon = 92
  const rows = [0.15, 0.28, 0.4, 0.55, 0.7, 0.85, 1].map((t) => horizon + 58 * t * t)
  const spokes = Array.from({ length: 15 }, (_, i) => -125 + i * 25)
  const stars: Array<[number, number, number]> = [
    [8, 10, 0.7], [22, 22, 0.5], [35, 8, 0.8], [47, 17, 0.5], [60, 6, 0.7], [72, 20, 0.5],
    [85, 9, 0.8], [93, 24, 0.5], [14, 34, 0.45], [64, 33, 0.45], [90, 40, 0.4], [30, 40, 0.4],
  ]
  return (
    <svg
      viewBox="0 0 100 150"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 size-full"
      aria-hidden
    >
      <defs>
        <linearGradient id="vw-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#120a30" />
          <stop offset="0.38" stopColor="#3a1273" />
          <stop offset="0.68" stopColor="#b1288f" />
          <stop offset="0.86" stopColor="#ff5e9c" />
          <stop offset="1" stopColor="#ffb36b" />
        </linearGradient>
        <linearGradient id="vw-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff176" />
          <stop offset="0.5" stopColor="#ff6fb5" />
          <stop offset="1" stopColor="#c61aa6" />
        </linearGradient>
        <linearGradient id="vw-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c0b52" />
          <stop offset="1" stopColor="#0c0524" />
        </linearGradient>
        {/* The sun is cut by bars that thicken toward the horizon, the genre's signature. */}
        <mask id="vw-sunmask">
          <rect width="100" height="150" fill="white" />
          <rect x="0" y="66" width="100" height="1" fill="black" />
          <rect x="0" y="71" width="100" height="1.6" fill="black" />
          <rect x="0" y="76.5" width="100" height="2.2" fill="black" />
          <rect x="0" y="82.5" width="100" height="2.8" fill="black" />
          <rect x="0" y="88.5" width="100" height="3.4" fill="black" />
        </mask>
      </defs>

      <rect width="100" height={horizon} fill="url(#vw-sky)" />
      {stars.map(([x, y, o], i) => (
        <circle key={i} cx={x} cy={y} r="0.5" fill={i % 3 === 0 ? '#7df9ff' : '#ffffff'} fillOpacity={o} />
      ))}

      {/* The sun, with a soft halo behind it. */}
      <circle cx="50" cy="68" r="38" fill="#ff5e9c" fillOpacity="0.14" />
      <circle cx="50" cy="68" r="31" fill="#ff8fd0" fillOpacity="0.16" />
      <circle cx="50" cy="68" r="26" fill="url(#vw-sun)" mask="url(#vw-sunmask)" />

      {/* Floor and grid. */}
      <rect y={horizon} width="100" height={150 - horizon} fill="url(#vw-floor)" />
      <g stroke="#2de2e6" strokeWidth="0.35" strokeOpacity="0.85">
        {rows.map((y, i) => (
          <line key={i} x1="0" x2="100" y1={y} y2={y} />
        ))}
        {spokes.map((xb, i) => (
          <line key={i} x1="50" y1={horizon} x2={xb} y2="150" />
        ))}
      </g>
      <rect y={horizon - 0.4} width="100" height="0.8" fill="#7df9ff" fillOpacity="0.9" />

      {/* Palms, in silhouette either side of the sun. */}
      <g stroke="#0a031c" strokeLinecap="round" fill="none">
        <path d="M12 94 C13 82 11 72 14 59" strokeWidth="1.7" />
        <g strokeWidth="1.2">
          <path d="M14 59 Q7 54 2 59" />
          <path d="M14 59 Q9 51 4 50" />
          <path d="M14 59 Q14 50 12 46" />
          <path d="M14 59 Q20 52 26 53" />
          <path d="M14 59 Q21 57 27 62" />
        </g>
        <path d="M88 94 C87 84 90 73 86 61" strokeWidth="1.7" />
        <g strokeWidth="1.2">
          <path d="M86 61 Q93 56 98 61" />
          <path d="M86 61 Q91 53 96 52" />
          <path d="M86 61 Q86 52 88 48" />
          <path d="M86 61 Q80 54 74 55" />
          <path d="M86 61 Q79 59 73 64" />
        </g>
      </g>
    </svg>
  )
}

function TicketScreen() {
  return (
    <div className="flex h-full flex-col">
      {/* The base colour is the scene's own deep violet, not a theme colour, so
          even before the artwork paints nothing of the page shows through. */}
      <div className="relative flex flex-1 flex-col justify-end overflow-hidden bg-[#120a30] p-4">
        <VaporwaveArt />
        {/* Same technique `EventPoster` uses over a real photo: a scrim so
            the title stays legible regardless of what the art behind it
            looks like, rather than tuning the art to dodge the text. */}
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent" />
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
 * `SCREEN` below is the transparent "screen cutout" rectangle, re-measured
 * after a second pass on the asset (2026-10): Apple's own bezel render
 * includes a genuine, OPAQUE black bezel ring between the metal rail and
 * the display glass — real black pixels (alpha 255), not transparent —
 * about 15-20px wide at this resolution, present on all four edges
 * (verified by sampling raw RGBA values across each edge). That ring is an
 * authentic part of the photographed device, but since the content layer
 * renders BELOW the frame image, no CSS change can cover pixels the PNG
 * itself draws opaque — enlarging the content div's box doesn't erase
 * pixels painted on top of it. The ring made the content visibly inset
 * from the metal edge ("black borders on the side"), which reads as
 * unfilled dead space rather than a deliberate bezel.
 *
 * Fixed at the asset level: a bounded flood-erosion (see the one-off script
 * that produced this file) scans inward from each edge, per row/column,
 * and converts the first contiguous run of near-black opaque pixels that
 * leads directly into the existing transparent hole into transparent
 * pixels too — extending the hole out to the ring's outer edge, flush
 * against the metal. The scan stops the instant it hits a transparent
 * pixel, so it only ever touches the ONE ring immediately bordering the
 * hole and never reaches the Dynamic Island (which sits isolated inside
 * the hole, with transparent pixels on every side long before any scan
 * from an outer edge could reach it) — confirmed by inspecting the eroded
 * result; the island's shape is untouched.
 *
 * Re-measured post-erosion, as a percentage of the 880×1814 canvas (same
 * crop as before — only the hole grew, the outer crop didn't change):
 *   - left 2.386%, right 2.386%, top 3.252%, bottom 3.252% (now
 *     near-symmetric, vs. the old 4.25/4.33/7.32/1.77 — the top ring was
 *     noticeably thicker than the others before erosion).
 *   - corner radius: measured ~115px on the new ~838×1696px screen rect.
 *     Still the `x% / y%` elliptical form, not a single percentage, for
 *     the same reason as before — a single percentage radius resolves
 *     independently against width and height and reproduces the
 *     elongated-corner bug this file hit once already: 115/838 ≈ 13.72%
 *     horizontal, 115/1696 ≈ 6.78% vertical.
 * The content layer renders BELOW the frame image (z-0 vs. the image's
 * implicit stacking as the next sibling); the frame's own Dynamic-Island
 * and camera cutouts are baked into the PNG, so they composite over the
 * content for free instead of being redrawn by hand.
 */
const SCREEN = { left: 2.386, right: 2.386, top: 3.252, bottom: 3.252, radius: '13.72% / 6.78%' }

function PhoneFrame({ screen }: { screen: ScreenId }) {
  const Screen = SCREENS[screen]
  return (
    <div className="mx-auto w-full max-w-[300px]">
      {/* The device's shadow is a static, rounded box-shadow BEHIND the frame, not a
          CSS `drop-shadow` filter on the frame image. A filter on a large image inside
          a sticky element is re-rendered by Safari as the element moves, which is the
          phone visibly jittering on iPhones. A box-shadow is painted once. The corner
          radius is the device's (about 17% of its width), written as an ellipse so it
          stays circular at this aspect ratio, which is what stops it showing the
          hard-edged rectangle a plain box-shadow gave on its own. */}
      <div className="relative aspect-[1318/2717]">
        <div
          aria-hidden
          className="absolute inset-0 z-0 rounded-[17%/8.25%] shadow-[0_18px_22px_hsl(var(--shadow-color)/0.28)]"
        />
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
      const centers = refs.current.map((el) => {
        if (!el) return Infinity
        const rect = el.getBoundingClientRect()
        return rect.top + rect.height / 2
      })
      // With a margin, not a bare "nearest wins": see `chooseActiveStep`.
      setActive((current) => chooseActiveStep(centers, mid, current))
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
      {/* Below `sm` the header is two rows (~110px), so the old `top-16`
          (64px) parked the phone's top 46px UNDER it — island and status area
          cropped, measured with Playwright. 7.25rem clears it; `sm:` returns to
          the single-row header. */}
      {/* `transform-gpu`: the sticky phone gets its own compositor layer, the
          standard fix for sticky elements shimmering on iOS Safari. */}
      <div className="sticky top-[7.25rem] transform-gpu sm:top-20 lg:top-24">
        <PhoneFrame screen={STEPS[active]!.screen} />
      </div>

      {/* The step column used to be the blandest stretch of the whole page:
          each block reserves 42-65vh (tuned for the sticky-scroll pacing
          above, and left untouched here) for a few lines of text vertically
          centered in otherwise empty space — several full screens of nothing
          to look at while scrolling. A progress rail along the left edge
          fills that space with something that is actually true (how far
          through the five real steps you are, not a decorative filler), and
          the active step brightening while its neighbours dim gives the
          scroll a visible focal point instead of five identical-weight
          blocks. Both are plain CSS transitions on already-computed `active`
          state — no new motion plumbing, and already covered by index.css's
          global `prefers-reduced-motion` rule. */}
      <div className="relative space-y-0 pl-5 sm:pl-7">
        <div aria-hidden className="bg-border/70 absolute top-1 bottom-1 left-0 w-px sm:left-0.5">
          <div
            className="absolute inset-x-0 top-0 bg-[var(--accent)] transition-[height] duration-500 ease-out"
            style={{ height: `${((active + 1) / STEPS.length) * 100}%` }}
          />
        </div>
        {STEPS.map((s, i) => (
          <div
            key={s.title}
            ref={(el) => {
              refs.current[i] = el
            }}
            className="flex min-h-[42vh] flex-col justify-center py-6 sm:min-h-[55vh] lg:min-h-[65vh] lg:py-8"
          >
            {/* Only the TITLE dims. The body stays at full muted-foreground:
                the old `opacity-45` on the whole block took the body to ~2.3:1
                in dark mode (impeccable's live-DOM scan flagged four steps), and
                the title is large text, which has 3:1 to spend. The rail and
                the title carry the focal point; the body never needs to hide. */}
            <div>
              <h3
                className={`max-w-md text-base leading-snug font-medium tracking-[-0.02em] text-balance transition-opacity duration-300 sm:text-xl lg:text-2xl ${
                  i === active ? 'opacity-100' : 'opacity-50'
                }`}
              >
                {s.title}
              </h3>
              <p className="text-muted-foreground mt-2.5 max-w-sm text-xs leading-relaxed text-pretty sm:mt-3 sm:text-sm">
                {s.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
