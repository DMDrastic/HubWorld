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
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2 } from 'lucide-react'
import iphoneFrame from '@/assets/iphone-17-pro-cosmic-orange-portrait.png'
import { chooseActiveStep } from '@/lib/active-step'
import { SCREEN } from '@/lib/phone-frame'

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
 * Every screen in the phone is a full-bleed vaporwave scene with its content laid
 * over it, so the glass is never left showing the page's own colour above or below
 * the content. Before this only the ticket had a picture; the other four were plain
 * `bg-card` with text centred in it, so in the light theme the top and bottom of the
 * phone were the site's white.
 *
 * The scenes are illustrated, not photographs, so there is nothing to download and
 * they stay crisp at any size. They share one drawing with a palette each. They fill
 * with `slice` (cover), on a dark base of their own, so there is never a gap.
 *
 * The magenta, cyan and violet are the point of the style, and the project's own
 * design notes ban purple-and-pink gradients for UI. They are kept to these phone
 * illustrations, at the owner's request, and nothing on the page itself uses them.
 */
type Palette = {
  /** Five stops, zenith to horizon. */
  sky: [string, string, string, string, string]
  /** A striped sun resting on the horizon; omitted for a moonlit scene. */
  sun?: { stops: [string, string, string]; y: number; r: number }
  moon?: { x: number; y: number; r: number }
  floor: [string, string]
  grid: string
  palms?: boolean
}

const SUNSET: Palette = {
  sky: ['#120a30', '#3a1273', '#b1288f', '#ff5e9c', '#ffb36b'],
  sun: { stops: ['#fff176', '#ff6fb5', '#c61aa6'], y: 68, r: 26 },
  floor: ['#2c0b52', '#0c0524'],
  grid: '#2de2e6',
  palms: true,
}
const NIGHT: Palette = {
  sky: ['#050316', '#120a3d', '#2a1473', '#5a2aa3', '#9b4be0'],
  moon: { x: 68, y: 30, r: 15 },
  floor: ['#1a0a3d', '#080420'],
  grid: '#ff4fd8',
}
const DUSK: Palette = {
  sky: ['#150726', '#3d0f5c', '#a3237f', '#ff5a7a', '#ffb066'],
  sun: { stops: ['#fff3a0', '#ffb347', '#ff5e7a'], y: 72, r: 22 },
  floor: ['#2a0840', '#0b0420'],
  grid: '#ff7ad9',
}
const TWILIGHT: Palette = {
  sky: ['#050d26', '#0a2352', '#15509a', '#2b97c4', '#9af0ee'],
  sun: { stops: ['#ffffff', '#bff8ff', '#5fd9e6'], y: 74, r: 20 },
  floor: ['#082a4a', '#040f24'],
  grid: '#7df9ff',
}
const NEON: Palette = {
  sky: ['#021311', '#05332e', '#0a6b5c', '#14b894', '#8dffd9'],
  sun: { stops: ['#f4ff8a', '#7dffb0', '#14b894'], y: 72, r: 22 },
  floor: ['#06382f', '#02120f'],
  grid: '#7dffb0',
}

function VaporBackdrop({ palette }: { palette: Palette }) {
  // All five scenes are mounted at once, so each needs ids of its own; two
  // `<linearGradient id="sky">` in one document would all resolve to the first.
  const uid = useId().replace(/:/g, '')
  const horizon = 92
  // Perspective grid: horizontal lines bunch toward the horizon the way a receding
  // floor does, and the verticals all run to one vanishing point.
  const rows = [0.15, 0.28, 0.4, 0.55, 0.7, 0.85, 1].map((t) => horizon + 58 * t * t)
  const spokes = Array.from({ length: 15 }, (_, i) => -125 + i * 25)
  const stars: Array<[number, number, number]> = [
    [8, 10, 0.7], [22, 22, 0.5], [35, 8, 0.8], [47, 17, 0.5], [60, 6, 0.7], [72, 20, 0.5],
    [85, 9, 0.8], [93, 24, 0.5], [14, 34, 0.45], [64, 33, 0.45], [90, 40, 0.4], [30, 40, 0.4],
    [50, 30, 0.5], [78, 45, 0.4], [6, 50, 0.4],
  ]
  const { sky, sun, moon, floor, grid, palms } = palette

  return (
    <svg
      viewBox="0 0 100 150"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 size-full"
      aria-hidden
    >
      <defs>
        <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={sky[0]} />
          <stop offset="0.38" stopColor={sky[1]} />
          <stop offset="0.68" stopColor={sky[2]} />
          <stop offset="0.86" stopColor={sky[3]} />
          <stop offset="1" stopColor={sky[4]} />
        </linearGradient>
        <linearGradient id={`${uid}-floor`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={floor[0]} />
          <stop offset="1" stopColor={floor[1]} />
        </linearGradient>
        {sun && (
          <linearGradient id={`${uid}-sun`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={sun.stops[0]} />
            <stop offset="0.5" stopColor={sun.stops[1]} />
            <stop offset="1" stopColor={sun.stops[2]} />
          </linearGradient>
        )}
        {/* The sun is cut by bars that thicken toward the horizon, the genre's signature. */}
        <mask id={`${uid}-bars`}>
          <rect width="100" height="150" fill="white" />
          <rect x="0" y="66" width="100" height="1" fill="black" />
          <rect x="0" y="71" width="100" height="1.6" fill="black" />
          <rect x="0" y="76.5" width="100" height="2.2" fill="black" />
          <rect x="0" y="82.5" width="100" height="2.8" fill="black" />
          <rect x="0" y="88.5" width="100" height="3.4" fill="black" />
        </mask>
      </defs>

      <rect width="100" height={horizon} fill={`url(#${uid}-sky)`} />
      {stars.map(([x, y, o], i) => (
        <circle key={i} cx={x} cy={y} r="0.5" fill={i % 3 === 0 ? grid : '#ffffff'} fillOpacity={o} />
      ))}

      {sun && (
        <>
          <circle cx="50" cy={sun.y} r={sun.r + 12} fill={sun.stops[1]} fillOpacity="0.14" />
          <circle cx="50" cy={sun.y} r={sun.r + 5} fill={sun.stops[1]} fillOpacity="0.16" />
          <circle cx="50" cy={sun.y} r={sun.r} fill={`url(#${uid}-sun)`} mask={`url(#${uid}-bars)`} />
        </>
      )}
      {moon && (
        <>
          <circle cx={moon.x} cy={moon.y} r={moon.r + 9} fill="#c9b8ff" fillOpacity="0.1" />
          <circle cx={moon.x} cy={moon.y} r={moon.r + 4} fill="#c9b8ff" fillOpacity="0.16" />
          <circle cx={moon.x} cy={moon.y} r={moon.r} fill="#f1ecff" />
          <circle cx={moon.x - 4} cy={moon.y - 3} r={moon.r * 0.22} fill="#d6ccff" fillOpacity="0.8" />
          <circle cx={moon.x + 5} cy={moon.y + 4} r={moon.r * 0.15} fill="#d6ccff" fillOpacity="0.8" />
        </>
      )}

      <rect y={horizon} width="100" height={150 - horizon} fill={`url(#${uid}-floor)`} />
      <g stroke={grid} strokeWidth="0.35" strokeOpacity="0.85">
        {rows.map((y, i) => (
          <line key={i} x1="0" x2="100" y1={y} y2={y} />
        ))}
        {spokes.map((xb, i) => (
          <line key={i} x1="50" y1={horizon} x2={xb} y2="150" />
        ))}
      </g>
      <rect y={horizon - 0.4} width="100" height="0.8" fill={grid} fillOpacity="0.9" />

      {palms && (
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
      )}
    </svg>
  )
}

/** A screen's frame: its scene, filling the glass, with the content laid over it. */
function ScreenShell({ palette, children }: { palette: Palette; children: ReactNode }) {
  return (
    // The dark base is the scene's own, not a theme colour: nothing of the page can
    // show through, before the art paints or while a screen is fading.
    <div className="relative h-full overflow-hidden bg-[#0a0420] text-white">
      <VaporBackdrop palette={palette} />
      {children}
    </div>
  )
}

/** Content sits in a dark panel so it reads against any part of the scene behind it. */
const PANEL = 'rounded-2xl bg-[#0a0420]/75 ring-1 ring-white/15'

function TicketScreen() {
  return (
    <ScreenShell palette={SUNSET}>
      {/* A scrim so the title stays legible whatever the art behind it looks like,
          rather than tuning the art to dodge the text (the technique `EventPoster`
          uses over a real photo). */}
      <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/80 via-black/45 to-transparent" />
      <div className="relative flex h-full flex-col justify-end gap-3 p-4">
        <div>
          <div className="font-heading text-lg leading-tight font-semibold tracking-[-0.02em] text-white">
            Skyline Sessions
          </div>
          <div className="mt-1 font-mono text-[0.6rem] tracking-[0.18em] text-white/70 uppercase">
            The Observatory, Rooftop
          </div>
        </div>
        <div className={`${PANEL} space-y-2.5 p-4 text-xs`}>
          <div className="flex items-center justify-between">
            <span className="text-white/65">Held by</span>
            <span className="font-mono">@arin_k</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white/65">Token</span>
            <span className="font-mono">000861…A42F</span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 font-medium text-emerald-200 ring-1 ring-emerald-300/30">
            not yet redeemed
          </span>
        </div>
      </div>
    </ScreenShell>
  )
}

function GiftScreen() {
  return (
    <ScreenShell palette={NIGHT}>
      <div className="relative flex h-full flex-col justify-center px-4">
        <div className={`${PANEL} p-5 text-center`}>
          <div className="text-sm font-medium text-white">Gift a ticket</div>
          <div className="mt-1 text-xs text-white/70">
            Free peer-to-peer. Two signatures — you offer it, they accept it.
          </div>
          <div className="mt-5 rounded-xl bg-white/10 p-4">
            <div className="text-[0.65rem] text-white/65">Gift to</div>
            <div className="mt-0.5 font-mono text-sm">@mina_v</div>
            <span className="mt-3 inline-flex items-center rounded-full bg-white/10 px-2.5 py-1 text-[0.65rem] font-medium text-white ring-1 ring-white/25">
              offered
            </span>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-white/70">
            Offer is live on-ledger. @mina_v can now accept.
          </p>
        </div>
      </div>
    </ScreenShell>
  )
}

function AuctionScreen() {
  const points = '0,38 10,38 10,30 30,30 30,20 55,20 55,6 90,6'
  return (
    <ScreenShell palette={DUSK}>
      <div className="relative flex h-full flex-col justify-center px-4">
        <div className={`${PANEL} p-5`}>
          <div className="font-mono text-[0.65rem] tracking-[0.14em] text-white/65 uppercase">
            Leading bid
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-3xl font-semibold tabular-nums">13.00</span>
            <span className="text-xs font-medium text-white/65">XRP</span>
          </div>
          <div className="mt-1 text-xs text-white/65">@mina_v · just now</div>
          <svg viewBox="0 0 90 44" className="mt-5 h-16 w-full" preserveAspectRatio="none" aria-hidden>
            <polyline
              points={points}
              fill="none"
              stroke="#7df9ff"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          <div className="mt-4 flex items-center justify-between text-xs">
            <span className="text-white/65">Reserve</span>
            <span className="font-mono text-emerald-300">met</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs">
            <span className="text-white/65">Bids</span>
            <span className="font-mono">4 / 3 bidders</span>
          </div>
        </div>
      </div>
    </ScreenShell>
  )
}

function CapScreen() {
  return (
    <ScreenShell palette={TWILIGHT}>
      <div className="relative flex h-full flex-col justify-center px-4">
        <div className={`${PANEL} p-5`}>
          <div className="mb-3 text-xs text-white/80">Cap is 150% of face value (12.00 XRP)</div>
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-lg bg-black/30 px-3 py-2 font-mono text-sm text-white/80 ring-1 ring-white/20">
              15
            </div>
            <span className="rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-neutral-950">
              List
            </span>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-rose-300">
            This event&rsquo;s organizer has limited resale prices to 12 XRP.
          </p>
        </div>
      </div>
    </ScreenShell>
  )
}

function DoorScreen() {
  return (
    <ScreenShell palette={NEON}>
      <div className="relative flex h-full flex-col justify-center px-4">
        <div className={`${PANEL} flex flex-col items-center p-5 text-center`}>
          <div className="flex size-14 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-300/30">
            <CheckCircle2 className="size-7" aria-hidden />
          </div>
          <div className="mt-4 text-lg font-semibold text-emerald-300">Admitted</div>
          <div className="mt-1 text-xs text-white/70">Valid ticket, checked in.</div>
          <div className="mt-3 font-mono text-xs">@arin_k</div>
        </div>
      </div>
    </ScreenShell>
  )
}

const SCREEN_IDS: ScreenId[] = ['ticket', 'gift', 'auction', 'cap', 'door']

const SCREENS: Record<ScreenId, () => React.JSX.Element> = {
  ticket: TicketScreen,
  gift: GiftScreen,
  auction: AuctionScreen,
  cap: CapScreen,
  door: DoorScreen,
}

/**
 * The real bezel: Apple's own "iPhone 17 Pro, Cosmic Orange, Portrait" product-bezel
 * asset (developer.apple.com/design/resources, Product Bezels, free to use when
 * showcasing an app), cropped to the device's exact opaque bounding box so the
 * `<img>`'s own edges coincide with the visible silhouette and there is no dead
 * margin for a hairline to attach to.
 *
 * The screen content is drawn BEHIND the frame and shows through the image's
 * transparent hole; the Dynamic Island and camera are baked into the PNG, so they
 * composite over the content for free. Where the hole is, and how far the content
 * reaches into it, is `SCREEN` in `lib/phone-frame.ts`, measured from the image
 * and checked by a test against the real file.
 */
function PhoneFrame({ screen }: { screen: ScreenId }) {
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
          /* The glass has a dark base of its own (the scenes' deep violet), not a theme
             token. `bg-card` here was white in the light theme, and showed above and
             below any screen that did not paint to its edges. */
          className="absolute z-0 overflow-hidden bg-[#0a0420]"
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
          {/* All five screens stay mounted and CROSS-FADE by opacity. The old version
              destroyed and rebuilt the visible screen, art included, every time the
              step changed, which put a layout and paint hitch in the middle of the
              scroll, and showed the theme's white behind each fade-in. Changing
              opacity is done by the compositor alone, so a step change costs the main
              thread nothing. Only the active one is exposed to assistive tech. */}
          {SCREEN_IDS.map((id) => {
            const Each = SCREENS[id]
            return (
              <div
                key={id}
                aria-hidden={id !== screen}
                className={`absolute inset-0 transition-opacity duration-300 ${
                  id === screen ? 'opacity-100' : 'pointer-events-none opacity-0'
                }`}
              >
                <Each />
              </div>
            )
          })}
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
