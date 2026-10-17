/**
 * The signed-out landing page.
 *
 * Previously a visitor met a bare "Sign in with Xaman" card with no explanation
 * of what HubWorld is or why a wallet is involved. Asking someone to connect a
 * crypto wallet before telling them what the product does is the fastest way to
 * lose them.
 *
 * The copy leads with the ticketing, not the ledger. "Tickets you actually own"
 * is the promise; XRPL is how it is kept, mentioned second. The hub-world framing
 * is the product's own — a central place connecting you to everything you hold.
 */
import { ArrowLeftRight, Clock, Gift, Lock, Repeat2, ScanLine, Wallet } from 'lucide-react'
import { LandingAuctionDemo } from '@/components/LandingAuctionDemo'
import { SignIn } from '@/components/SignIn'
import type { AuthUser, Health } from '@/lib/api'

/**
 * A fixed demo "ticket" rendered with the same hue-from-slug gradient
 * `EventPoster`'s fallback uses, so this reads as a real HubWorld poster
 * rather than a one-off illustration invented for the landing page.
 */
function demoHue(slug: string): number {
  let h = 5381
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0
  return (Math.abs(h) * 137.508) % 360
}

const SETTLEMENT_POINTS = [
  {
    icon: Clock,
    title: 'The seller signs once, at the start',
    body: 'Opening an auction is a single signature. Settlement runs itself when the clock hits zero — nobody has to be online to collect.',
  },
  {
    icon: Lock,
    title: 'The royalty is native, not an invoice',
    body: "It's the XRPL's own TransferFee, charged by the ledger on what actually reaches the seller — not a side payment HubWorld collects and forwards.",
  },
  {
    icon: ArrowLeftRight,
    title: 'Losing bids cost nothing',
    body: 'An unmatched bid is just an inert offer only HubWorld could ever have accepted. Nothing was ever locked up, so there is nothing to refund.',
  },
]

const FEATURES = [
  {
    icon: Wallet,
    title: 'Your wallet, your ticket',
    body: 'Tickets live in your own wallet as NFTs, not in an account we control. Nobody can revoke one, and it works even if HubWorld disappears.',
  },
  {
    icon: Gift,
    title: 'Send one to a friend',
    body: 'Transfer a ticket to any @handle for free. No fees, no re-issuing, no asking permission.',
  },
  {
    icon: Repeat2,
    title: 'Resale that pays the organizer',
    body: 'Sell at a fixed price or auction a sold-out show. The organizer earns a royalty on every resale, automatically.',
  },
  {
    icon: ScanLine,
    title: 'Scanned, not screenshotted',
    body: 'At the door you sign with your wallet. A screenshot cannot sign, so a forwarded QR gets nobody in.',
  },
]

const STEPS = [
  ['Connect', 'Sign in with Xaman and claim an @handle. That handle is how people find you — no raw wallet addresses.'],
  ['Collect', 'Buy, receive or win tickets. They arrive in your wallet as NFTs you can see in the app or in Xaman.'],
  ['Walk in', 'At the door, scan and sign. Your ticket is checked against the ledger and marked used.'],
] as const

/**
 * What the badge claims, given what we actually know.
 *
 * This used to read "Live on XRPL testnet" as a hardcoded string, which was
 * true on the day it was written and would have become a lie the moment
 * XRPL_NETWORK changed — on the first page every visitor sees, telling someone
 * holding a real ticket that it is play money.
 *
 * "Live on the XRP Ledger" is true on every network, so it is what gets said
 * whenever we are not positively sure otherwise, including when health has not
 * loaded yet. The qualifier is added ONLY when the server has told us it is a
 * test network — the one case where a visitor genuinely needs the caveat.
 */
function liveOn(network: Health['network']): string {
  return network === 'testnet' || network === 'devnet'
    ? `Live on XRPL ${network}`
    : 'Live on the XRP Ledger'
}

export function Landing({
  onAuthenticated,
  network,
}: {
  onAuthenticated: (u: AuthUser) => void
  /** From /api/health. Undefined until it loads, or on an API too old to say. */
  network?: Health['network']
}) {
  return (
    <div className="space-y-24 pb-16">
      {/* Hero. `<main>` elsewhere constrains every page to max-w-6xl, which is
          right for a dashboard but leaves the hero's glow dead-ending in a
          wall of flat background on anything wider than that column — the
          backdrop breaks out to the full viewport here so it reaches the
          edges of the screen the way it does in the design this followed;
          the actual copy below goes right back into the normal column so
          line length doesn't change. */}
      <section className="relative w-screen overflow-x-hidden mx-[calc(50%-50vw)]">
        <div
          className="aurora pointer-events-none absolute inset-x-0 -top-24 h-128 opacity-70"
          aria-hidden
        />
        {/* `.blob-field` bleeds 8% past its own edges on purpose (see index.css),
            so the section clips it rather than letting it widen the page. */}
        <div className="blob-field pointer-events-none absolute inset-x-0 -top-24" aria-hidden>
          <div className="blob blob-violet" />
          <div className="blob blob-teal" />
        </div>
        <div
          className="grid-faint pointer-events-none absolute inset-x-0 -top-16 h-[30rem] opacity-50"
          aria-hidden
        />

        <div className="relative mx-auto max-w-6xl px-4">
          <div className="relative grid items-start gap-12 pt-12 pb-2 lg:grid-cols-[1.05fr_1fr]">
            <div className="space-y-7">
              <span className="border-live/25 bg-live/10 text-live inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
                <span className="relative flex size-1.5">
                  <span className="bg-live absolute inline-flex size-full animate-ping rounded-full opacity-70" />
                  <span className="bg-live relative inline-flex size-1.5 rounded-full" />
                </span>
                {liveOn(network)}
              </span>

              <h1 className="text-gradient text-6xl leading-[1.0] font-semibold tracking-[-0.03em] text-balance sm:text-7xl">
                Every ticket you hold, in one hub.
              </h1>

              <p className="text-muted-foreground max-w-prose text-lg leading-relaxed text-pretty">
                HubWorld is event ticketing built on the XRP Ledger. Your tickets sit in your own
                wallet like an inventory — gift them, resell them, or bid on a sold-out night, and
                walk in by signing at the door.
              </p>

              <dl className="grid max-w-md grid-cols-3 gap-6 border-t pt-6">
                {[
                  ['Yours', 'held in your wallet'],
                  ['Traceable', 'every move on-ledger'],
                  ['No custody', 'we never hold funds'],
                ].map(([term, def]) => (
                  <div key={term}>
                    <dt className="text-foreground text-sm font-medium">{term}</dt>
                    <dd className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{def}</dd>
                  </div>
                ))}
              </dl>

              <div className="max-w-sm pt-2">
                <SignIn onAuthenticated={onAuthenticated} />
                <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                  Signing proves you control the wallet. No password, and your keys never leave
                  your device.
                </p>
              </div>
            </div>

            <div className="lg:pt-2">
              <LandingAuctionDemo />
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="group bg-card ring-foreground/8 hover:ring-primary/30 relative overflow-hidden rounded-2xl p-6 ring-1 transition-all hover:-translate-y-0.5"
          >
            <div className="bg-primary/10 text-primary ring-primary/15 mb-4 flex size-9 items-center justify-center rounded-xl ring-1">
              <f.icon className="size-4.5" aria-hidden />
            </div>
            <h2 className="font-medium tracking-tight">{f.title}</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed text-pretty">
              {f.body}
            </p>
          </div>
        ))}
      </section>

      <section className="space-y-8">
        <div className="max-w-prose space-y-3">
          <h2 className="text-muted-foreground font-mono text-xs font-medium tracking-[0.18em] uppercase">
            Settlement, not a promise
          </h2>
          <p className="text-3xl leading-snug font-medium tracking-tight text-balance sm:text-4xl">
            One signature moves the ticket and the money. Together, or not at
            all.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
          <div className="bg-card ring-foreground/8 rounded-2xl p-6 ring-1 sm:p-7">
            <div className="text-muted-foreground mb-4 font-mono text-xs tracking-[0.1em] uppercase">
              Measured on a public test network · 15.00 XRP winning bid
            </div>
            <dl className="divide-border divide-y text-sm">
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">Winning bid</dt>
                <dd className="font-mono tabular-nums">15.000000 XRP</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">Seller receives</dt>
                <dd className="text-primary font-mono tabular-nums">13.893750 XRP</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">Organizer royalty · 5%</dt>
                <dd className="font-mono tabular-nums">0.731250 XRP</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">HubWorld fee · 2.5%</dt>
                <dd className="font-mono tabular-nums">0.375000 XRP</dd>
              </div>
              <div className="flex items-center justify-between pt-3.5">
                <dt className="font-medium">Network fee, paid by the broker</dt>
                <dd className="text-live font-mono font-medium tabular-nums">12 drops</dd>
              </div>
            </dl>
            <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
              Confirmed again on mainnet, 2026-08-13: a 1 XRP winning bid paid
              the seller 0.926250, the issuer 0.048750, and the broker
              0.024988 — same split, real XRP, same 12 drops.
            </p>
          </div>

          <div className="space-y-6">
            {SETTLEMENT_POINTS.map((p) => (
              <div key={p.title} className="flex gap-3.5">
                <div className="bg-primary/10 text-primary ring-primary/15 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ring-1">
                  <p.icon className="size-4" aria-hidden />
                </div>
                <div>
                  <h3 className="text-sm font-medium tracking-tight">{p.title}</h3>
                  <p className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
                    {p.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-8">
        <div className="max-w-prose space-y-3">
          <h2 className="text-muted-foreground font-mono text-xs font-medium tracking-[0.18em] uppercase">
            Shipped October 2026
          </h2>
          <p className="text-3xl leading-snug font-medium tracking-tight text-balance sm:text-4xl">
            Organizers set the ceiling. The ledger enforces it.
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
            An organizer can cap resale at a percentage of face value, a flat
            price, face value exactly, or switch it off entirely — checked on
            the listing, on the auction&rsquo;s reserve, and on every bid that
            comes in after, so waiting for the auction doesn&rsquo;t buy
            anyone a way around it.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="bg-card ring-foreground/8 rounded-2xl p-5 ring-1">
            <div className="text-muted-foreground mb-3 text-xs">
              Cap is 150% of face value (12.00 XRP)
            </div>
            <div className="flex items-center gap-2.5">
              <div className="border-input bg-muted text-muted-foreground flex-1 rounded-lg border px-3 py-2 font-mono text-sm">
                15
              </div>
              <button
                type="button"
                disabled
                className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-100"
              >
                List
              </button>
            </div>
            <p className="text-destructive mt-3 text-sm leading-relaxed">
              This event&rsquo;s organizer has limited resale prices to 12 XRP.
            </p>
          </div>

          <div className="bg-card ring-foreground/8 rounded-2xl p-5 ring-1">
            <div className="text-muted-foreground mb-3 text-xs">Within the cap</div>
            <div className="flex items-center gap-2.5">
              <div className="border-input bg-muted text-muted-foreground flex-1 rounded-lg border px-3 py-2 font-mono text-sm">
                12
              </div>
              <button
                type="button"
                disabled
                className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-100"
              >
                List
              </button>
            </div>
            <p className="text-live mt-3 text-sm leading-relaxed">
              Listed. Waiting for a buyer.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-8">
        <h2 className="text-muted-foreground font-mono text-xs font-medium tracking-[0.18em] uppercase">
          How it works
        </h2>
        <ol className="grid gap-8 sm:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="relative space-y-2 border-t pt-5">
              {/* The rule above each step doubles as the connector between
                  them, so the sequence reads without drawing arrows. */}
              <span className="text-primary/70 font-mono text-xs tabular-nums">
                0{i + 1}
              </span>
              <h3 className="font-medium tracking-tight">{title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed text-pretty">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          <h2 className="text-muted-foreground font-mono text-xs font-medium tracking-[0.18em] uppercase">
            No account to freeze
          </h2>
          <p className="max-w-prose text-3xl leading-snug font-medium tracking-tight text-balance sm:text-4xl">
            Nobody can revoke a ticket that isn&rsquo;t in our database.
          </p>
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed text-pretty">
            A HubWorld ticket is an XRPL NFT sitting in your own wallet — the
            same wallet that holds your XRP. We can show it to you, but we
            were never holding it. Send one to a friend&rsquo;s @handle for
            free, and it still works even if HubWorld disappears tomorrow.
          </p>
        </div>

        {/* A fixed demo ticket, drawn with the same hue-from-slug gradient
            formula EventPoster's fallback uses — on-brand, not invented. */}
        <div className="ring-foreground/8 elevate overflow-hidden rounded-2xl ring-1">
          <div
            className="relative flex aspect-[5/3] flex-col justify-end p-5"
            style={{
              background: `linear-gradient(160deg,
                oklch(0.40 0.105 ${demoHue('skyline-sessions')}) 0%,
                oklch(0.24 0.075 ${(demoHue('skyline-sessions') + 25) % 360}) 58%,
                oklch(0.16 0.045 ${(demoHue('skyline-sessions') + 45) % 360}) 100%)`,
            }}
          >
            <div className="font-heading text-xl leading-tight font-semibold tracking-[-0.02em] text-white">
              Skyline Sessions
            </div>
            <div className="mt-1 font-mono text-[0.65rem] tracking-[0.18em] text-white/60 uppercase">
              The Observatory, Rooftop
            </div>
          </div>
          <div className="bg-card flex items-center justify-between gap-3 p-4 text-xs">
            <div>
              <div className="text-muted-foreground">Held by</div>
              <div className="mt-0.5 font-mono">@arin_k</div>
            </div>
            <div>
              <div className="text-muted-foreground">Token</div>
              <div className="mt-0.5 font-mono">000861…A42F</div>
            </div>
            <span className="bg-live/10 text-live border-live/25 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium">
              not yet redeemed
            </span>
          </div>
        </div>
      </section>

      <section className="ring-foreground/8 relative overflow-hidden rounded-2xl p-8 ring-1 sm:p-10">
        <div className="aurora pointer-events-none absolute inset-0 opacity-50" aria-hidden />
        <div className="relative max-w-prose">
          <h2 className="text-xl font-medium tracking-tight">Running events?</h2>
          <p className="text-muted-foreground mt-3 leading-relaxed text-pretty">
            Organizers mint tickets straight from their own wallet and set a royalty that follows
            every resale — so you keep earning when a ticket changes hands. Sign in and apply; each
            application is reviewed by a person.
          </p>
        </div>

        <dl className="relative mt-8 grid gap-6 border-t pt-6 sm:grid-cols-3">
          {[
            ['~2–3', 'signed payloads per ticket sold, measured at a real mainnet event'],
            ['≤20%', 'royalty cap — high enough to matter, capped so resale isn’t pointless'],
            ['1', 'signature opens an auction — you never sign again to settle it'],
          ].map(([num, def]) => (
            <div key={def}>
              <dt className="text-primary font-mono text-xl font-semibold tabular-nums">{num}</dt>
              <dd className="text-muted-foreground mt-1 text-xs leading-relaxed">{def}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
