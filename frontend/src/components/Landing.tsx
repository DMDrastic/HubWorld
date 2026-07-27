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
import { SignIn } from '@/components/SignIn'
import type { AuthUser } from '@/lib/api'

const FEATURES = [
  {
    title: 'Your wallet, your ticket',
    body: 'Tickets live in your own wallet as NFTs, not in an account we control. Nobody can revoke one, and it works even if HubWorld disappears.',
  },
  {
    title: 'Send one to a friend',
    body: 'Transfer a ticket to any @handle for free. No fees, no re-issuing, no asking permission.',
  },
  {
    title: 'Resale that pays the organizer',
    body: 'Sell at a fixed price or auction a sold-out show. The organizer earns a royalty on every resale, automatically.',
  },
  {
    title: 'Scanned, not screenshotted',
    body: 'At the door you sign with your wallet. A screenshot cannot sign, so a forwarded QR gets nobody in.',
  },
]

export function Landing({ onAuthenticated }: { onAuthenticated: (u: AuthUser) => void }) {
  return (
    <div className="space-y-16 py-10">
      <section className="grid items-start gap-10 md:grid-cols-2">
        <div className="space-y-5">
          <span className="border-primary/20 bg-primary/5 text-primary inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium">
            <span className="bg-primary size-1.5 rounded-full" aria-hidden />
            Live on XRPL testnet
          </span>

          <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
            Every ticket you hold, in one hub.
          </h1>

          <p className="text-muted-foreground max-w-prose text-lg text-pretty">
            HubWorld is event ticketing built on the XRP Ledger. Your tickets sit in your own
            wallet like an inventory — gift them, resell them, or bid on a sold-out night, and
            walk in by signing at the door.
          </p>

          <dl className="text-muted-foreground grid grid-cols-3 gap-4 pt-2 text-sm">
            <div>
              <dt className="text-foreground font-medium">Yours</dt>
              <dd>held in your wallet</dd>
            </div>
            <div>
              <dt className="text-foreground font-medium">Traceable</dt>
              <dd>every move on-ledger</dd>
            </div>
            <div>
              <dt className="text-foreground font-medium">No custody</dt>
              <dd>we never hold funds</dd>
            </div>
          </dl>
        </div>

        <div className="md:pt-4">
          <SignIn onAuthenticated={onAuthenticated} />
          <p className="text-muted-foreground mt-3 text-center text-xs">
            Signing proves you control the wallet. No password, and your keys never leave your
            device.
          </p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="bg-card/40 rounded-lg border p-5">
            <h2 className="font-medium">{f.title}</h2>
            <p className="text-muted-foreground mt-1.5 text-sm text-pretty">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-medium tracking-wide uppercase">How it works</h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {[
            ['Connect', 'Sign in with Xaman and claim an @handle. That handle is how people find you — no raw wallet addresses.'],
            ['Collect', 'Buy, receive or win tickets. They arrive in your wallet as NFTs you can see in the app or in Xaman.'],
            ['Walk in', 'At the door, scan and sign. Your ticket is checked against the ledger and marked used.'],
          ].map(([title, body], i) => (
            <li key={title} className="space-y-1.5">
              <span className="text-muted-foreground font-mono text-xs">0{i + 1}</span>
              <h3 className="font-medium">{title}</h3>
              <p className="text-muted-foreground text-sm text-pretty">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-lg border p-6">
        <h2 className="font-medium">Running events?</h2>
        <p className="text-muted-foreground mt-1.5 max-w-prose text-sm text-pretty">
          Organizers mint tickets straight from their own wallet and set a royalty that follows
          every resale — so you keep earning when a ticket changes hands. Sign in and apply; each
          application is reviewed by a person.
        </p>
      </section>
    </div>
  )
}
