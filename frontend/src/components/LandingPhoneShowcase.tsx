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
 * Below `lg:`, the phone is NOT squeezed into a side column — three earlier
 * attempts, in order:
 *
 * - `lg:sticky` (not sticky below `lg:`): no scroll effect on mobile at all.
 * - `flex-col` below `lg:`, phone full-width on top, steps stacked below:
 *   sticky worked, but the full-width phone now sat on top of the steps'
 *   normal document flow, so the step TEXT scrolled visibly underneath it —
 *   "the background goes behind the phone."
 * - A two-column `grid` at every width, phone in a narrow ~35% column:
 *   no more overlap, but a phone squeezed to ~140px wide on a 390px screen
 *   reads as "small and weird," not like the desktop version at all.
 *
 * The fix is to stop trying to show five blocks of text AND a phone at full
 * size in a 390px-wide space at the same time — that is what every attempt
 * above was really fighting. Below `lg:`, only ONE caption is ever visible,
 * directly under the phone, showing whichever step is currently active —
 * the same "one screen, one caption" a native app's own onboarding carousel
 * uses, rather than a cut-down copy of the desktop layout. The five step
 * blocks still exist below `lg:` (`refs`, `min-h-*`) purely as invisible
 * scroll triggers for the SAME IntersectionObserver driving the phone — their
 * actual heading/body text is `hidden` and only appears at `lg:`, where
 * there is finally room to lay all five out beside a full-size phone.
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'

function demoHue(slug: string): number {
  let h = 5381
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0
  return (Math.abs(h) * 137.508) % 360
}

type ScreenId = 'ticket' | 'gift' | 'auction' | 'cap' | 'door'

const STEPS: { eyebrow: string; title: string; body: string; screen: ScreenId }[] = [
  {
    eyebrow: '01',
    title: "It's in your wallet, not our database",
    body: 'Every ticket is an XRPL NFT the moment it’s minted. We can show it to you — we were never holding it, and nobody can revoke it.',
    screen: 'ticket',
  },
  {
    eyebrow: '02',
    title: 'Send it to a friend, free',
    body: 'Two signatures, no fees, no re-issuing. A ticket moves exactly like anything else you own.',
    screen: 'gift',
  },
  {
    eyebrow: '03',
    title: 'Watch the price climb, live',
    body: 'A bid is a buy offer on the ledger. The price only moves when one actually lands — never faked, never hidden.',
    screen: 'auction',
  },
  {
    eyebrow: '04',
    title: 'Scalpers hit a real ceiling',
    body: 'Organizers can cap resale at a percentage of face value, a flat price, or switch it off — enforced on every listing, reserve, and bid.',
    screen: 'cap',
  },
  {
    eyebrow: '05',
    title: "A screenshot can't sign",
    body: 'At the door, the attendee signs with their own key. A forwarded photo has nothing behind it to sign with.',
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
 * A chassis colour has to read against EITHER theme, and the first version
 * failed on dark: its bezel (`#0a0a0c`) was close enough to dark mode's
 * `--background` (`#09090d`) that the frame was functionally invisible. A
 * real device's colour doesn't change with the app running on it, so this
 * stays literal rather than a theme token — titanium's edge highlight does
 * the same job in promotional renders: a brushed-metal gradient reads as a
 * frame at a glance in a way a flat fill, dark OR light, does not.
 */
const TITANIUM =
  'linear-gradient(155deg, #6b6b72 0%, #3a3a40 14%, #222226 50%, #3a3a40 86%, #6b6b72 100%)'
const BODY = 'linear-gradient(155deg, #302f33 0%, #1c1b1e 50%, #302f33 100%)'

/**
 * Every measurement below is a PERCENTAGE of the frame's own box, not a
 * fixed rem value, specifically so the chassis — buttons, island, screen
 * inset — stays in proportion whether this renders at mobile width or the
 * larger sticky desktop size, rather than looking right at one and wrong at
 * the other.
 */
function PhoneFrame({ screen }: { screen: ScreenId }) {
  const Screen = SCREENS[screen]
  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div
        className="elevate relative aspect-[9/19.5] overflow-hidden rounded-[3.1rem]"
        style={{ background: TITANIUM, padding: '2.6%' }}
      >
        {/* Action button, then two volume buttons — left edge, top to bottom. */}
        <div
          className="absolute -left-px h-[3.5%] w-[1.6%] rounded-l-sm"
          style={{ top: '14%', background: 'rgba(0,0,0,0.45)' }}
          aria-hidden
        />
        <div
          className="absolute -left-px h-[6%] w-[1.6%] rounded-l-sm"
          style={{ top: '20%', background: 'rgba(0,0,0,0.45)' }}
          aria-hidden
        />
        <div
          className="absolute -left-px h-[6%] w-[1.6%] rounded-l-sm"
          style={{ top: '27.5%', background: 'rgba(0,0,0,0.45)' }}
          aria-hidden
        />
        {/* Power button — right edge. */}
        <div
          className="absolute -right-px h-[9%] w-[1.6%] rounded-r-sm"
          style={{ top: '18%', background: 'rgba(0,0,0,0.45)' }}
          aria-hidden
        />

        <div
          className="relative size-full overflow-hidden rounded-[2.6rem]"
          style={{ background: BODY }}
        >
          <div
            className="bg-background absolute overflow-hidden rounded-[2.2rem]"
            style={{ inset: '7px' }}
          >
            <div
              className="absolute left-1/2 z-10 -translate-x-1/2 rounded-full"
              style={{ top: '2.4%', height: '3.3%', width: '32%', background: '#000' }}
              aria-hidden
            />
            <div className="absolute inset-0" style={{ paddingTop: '8.5%' }}>
              <div key={screen} className="screen-fade h-full">
                <Screen />
              </div>
            </div>
            {/* A faint diagonal gloss, the way a glass screen catches light in
                product photography — purely decorative, so it's excluded from
                the fade/remount key and never competes with the content. */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, transparent 32%)',
              }}
              aria-hidden
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export function LandingPhoneShowcase() {
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const idx = refs.current.findIndex((el) => el === entry.target)
          if (idx !== -1) setActive(idx)
        }
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    )
    refs.current.forEach((el) => el && observer.observe(el))
    return () => observer.disconnect()
  }, [])

  const current = STEPS[active]!

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-[1fr_1.05fr] lg:items-start lg:gap-12">
      <div className="sticky top-16 z-10 lg:top-24">
        <PhoneFrame screen={current.screen} />

        {/* Mobile/tablet only: one caption for the active step, directly
            under the phone — the full five-step column below is `hidden`
            at this width (see the step blocks), so there is nothing behind
            the phone for this to overlap. Re-keyed per step so it reuses
            the same crossfade the phone's screen does. */}
        <div key={active} className="screen-fade mx-auto mt-5 max-w-[300px] text-center lg:hidden">
          <span className="text-primary/70 font-mono text-xs tabular-nums">{current.eyebrow}</span>
          <h3 className="mt-1.5 text-lg leading-snug font-medium tracking-tight text-balance">
            {current.title}
          </h3>
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed text-pretty">
            {current.body}
          </p>
        </div>
      </div>

      {/* Five scroll triggers, always — `refs` and height are what drive the
          IntersectionObserver at every width. Below `lg:` they carry no
          visible content of their own (the mobile caption above covers
          that); at `lg:` the real heading/body appears beside the phone,
          same as before. */}
      <div className="space-y-0">
        {STEPS.map((s, i) => (
          <div
            key={s.title}
            ref={(el) => {
              refs.current[i] = el
            }}
            className="min-h-[42vh] py-6 sm:min-h-[50vh] lg:flex lg:min-h-[65vh] lg:flex-col lg:justify-center lg:py-8"
          >
            <div className="hidden lg:block">
              <span className="text-primary/70 font-mono text-xs tabular-nums">{s.eyebrow}</span>
              <h3 className="mt-2 max-w-md text-2xl leading-snug font-medium tracking-tight text-balance">
                {s.title}
              </h3>
              <p className="text-muted-foreground mt-3 max-w-sm text-sm leading-relaxed text-pretty">
                {s.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
