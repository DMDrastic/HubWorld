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
 * The phone only STICKS at `lg:` — below that there is no room for a device
 * frame beside a column of text, so it sits once at the top of the section
 * and its screen still updates as the steps below it scroll past.
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

function TicketScreen() {
  const slug = 'skyline-sessions'
  return (
    <div className="flex h-full flex-col">
      <div
        className="relative flex flex-1 flex-col justify-end p-4"
        style={{
          background: `linear-gradient(160deg,
            oklch(0.40 0.105 ${demoHue(slug)}) 0%,
            oklch(0.24 0.075 ${(demoHue(slug) + 25) % 360}) 58%,
            oklch(0.16 0.045 ${(demoHue(slug) + 45) % 360}) 100%)`,
        }}
      >
        <div className="font-heading text-lg leading-tight font-semibold tracking-[-0.02em] text-white">
          Skyline Sessions
        </div>
        <div className="mt-1 font-mono text-[0.6rem] tracking-[0.18em] text-white/60 uppercase">
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

function PhoneFrame({ screen }: { screen: ScreenId }) {
  const Screen = SCREENS[screen]
  return (
    <div className="mx-auto w-full max-w-[280px]">
      <div
        className="elevate relative aspect-[9/19.3] overflow-hidden rounded-[2.75rem] p-2"
        style={{ background: '#0a0a0c' }}
      >
        <div className="bg-background relative size-full overflow-hidden rounded-[2.1rem]">
          <div
            className="absolute top-2.5 left-1/2 z-10 h-5 w-24 -translate-x-1/2 rounded-full"
            style={{ background: '#0a0a0c' }}
            aria-hidden
          />
          <div className="absolute inset-0 pt-9">
            <div key={screen} className="screen-fade h-full">
              <Screen />
            </div>
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

  return (
    <div className="grid gap-12 lg:grid-cols-[1fr_1.05fr] lg:items-start">
      <div className="lg:sticky lg:top-24">
        <PhoneFrame screen={STEPS[active]!.screen} />
      </div>

      <div className="space-y-0">
        {STEPS.map((s, i) => (
          <div
            key={s.title}
            ref={(el) => {
              refs.current[i] = el
            }}
            className="flex min-h-[55vh] flex-col justify-center py-8 lg:min-h-[65vh]"
          >
            <span className="text-primary/70 font-mono text-xs tabular-nums">{s.eyebrow}</span>
            <h3 className="mt-2 max-w-md text-2xl leading-snug font-medium tracking-tight text-balance">
              {s.title}
            </h3>
            <p className="text-muted-foreground mt-3 max-w-sm text-sm leading-relaxed text-pretty">
              {s.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
