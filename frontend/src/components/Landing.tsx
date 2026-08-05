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
import { Gift, Repeat2, ScanLine, Wallet } from 'lucide-react'
import { SignIn } from '@/components/SignIn'
import type { AuthUser, Health } from '@/lib/api'

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
      {/* No aurora, deliberately. A violet wash behind the hero is the house
          style of every crypto product, and it announced "crypto project"
          before anyone read the copy — which fights the whole positioning,
          since this page leads with the ticketing and mentions the ledger
          second. The colour now comes from the type and the mark. */}
      <section className="relative">

        <div className="relative grid items-start gap-12 pt-12 pb-2 md:grid-cols-[1.1fr_1fr]">
          <div className="space-y-6">
            <span className="border-live/25 bg-live/10 text-live inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
              <span className="relative flex size-1.5">
                <span className="bg-live absolute inline-flex size-full animate-ping rounded-full opacity-70" />
                <span className="bg-live relative inline-flex size-1.5 rounded-full" />
              </span>
              {liveOn(network)}
            </span>

            {/* Flat, not the violet-fading gradient it used to carry. A
                gradient headline over a dark ground is the single most
                recognisable move in crypto and AI landing pages, and it read as
                decoration where plain white reads as confidence. The accent now
                appears only where something can be clicked. */}
            <h1 className="text-5xl leading-[1.02] font-semibold tracking-[-0.03em] text-balance sm:text-6xl">
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
          </div>

          <div className="md:pt-2">
            <SignIn onAuthenticated={onAuthenticated} />
            <p className="text-muted-foreground mx-auto mt-4 max-w-xs text-center text-xs leading-relaxed">
              Signing proves you control the wallet. No password, and your keys never leave your
              device.
            </p>
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
        <h2 className="text-muted-foreground text-xs font-medium tracking-[0.18em] uppercase">
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

      <section className="ring-foreground/8 relative overflow-hidden rounded-2xl p-8 ring-1 sm:p-10">
        <div className="relative max-w-prose">
          <h2 className="text-xl font-medium tracking-tight">Running events?</h2>
          <p className="text-muted-foreground mt-3 leading-relaxed text-pretty">
            Organizers mint tickets straight from their own wallet and set a royalty that follows
            every resale — so you keep earning when a ticket changes hands. Sign in and apply; each
            application is reviewed by a person.
          </p>
        </div>
      </section>
    </div>
  )
}
