import { useEffect, useState } from 'react'
import { CalendarDays, MapPin } from 'lucide-react'
import { fetchInventory, type OwnedTicket } from '@/lib/api'
import { hueFrom, posterUrl } from '@/lib/poster'
import { useLinkHandler } from '@/lib/router'
import { Button } from '@/components/ui/button'

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** What a holder needs to know about a ticket's state, in words a door would use. */
const STATE: Record<string, { label: string; tone: 'valid' | 'quiet' }> = {
  MINTED: { label: 'Valid', tone: 'valid' },
  LISTED: { label: 'Listed for sale', tone: 'quiet' },
  IN_AUCTION: { label: 'In an auction', tone: 'quiet' },
  REDEEMED: { label: 'Used', tone: 'quiet' },
  BURNED: { label: 'No longer valid', tone: 'quiet' },
}

/**
 * The tickets you hold, drawn as tickets.
 *
 * This page used to be a gift form and a handle lookup, so a holder with a
 * ticket in their wallet saw two utility cards and nothing that said "you have
 * one". The ticket is the thing they came for, so it is the largest object here:
 * a stub with the event's own colour, the date and place set large, and a tear
 * line, in the same hue the poster wall gives that event so it is recognisably
 * the thing they bought.
 *
 * Fetched without `verify`: reconciling every ticket against the ledger is a
 * round trip per ticket, and the gift form below already does it before anything
 * is acted on. A ticket the ledger disagrees with says so on its card.
 */
export function TicketWallet({
  version,
  onGift,
}: {
  /** Bumped by the page when something it did may have moved a ticket. */
  version: number
  onGift: (nfTokenId: string) => void
}) {
  const [tickets, setTickets] = useState<OwnedTicket[] | null>(null)
  const [failed, setFailed] = useState(false)
  const link = useLinkHandler()

  useEffect(() => {
    let stopped = false
    fetchInventory(false).then(
      (inv) => {
        if (stopped) return
        setTickets(inv.tickets.filter((t) => t.status !== 'BURNED'))
        setFailed(false)
      },
      () => {
        if (!stopped) setFailed(true)
      },
    )
    return () => {
      stopped = true
    }
  }, [version])

  if (failed && tickets === null) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        We couldn't load your tickets just now. Try reloading the page.
      </p>
    )
  }
  if (tickets === null) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Loading your tickets…
      </p>
    )
  }

  if (tickets.length === 0) {
    return (
      <div className="border-foreground/15 rounded-2xl border border-dashed p-8 text-center">
        <p className="text-lg font-medium">No tickets yet</p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm leading-relaxed">
          When you buy or are given a ticket, it appears here.
        </p>
        <a
          href="/events"
          onClick={link('/events')}
          className="text-foreground mt-4 inline-block text-sm font-medium underline underline-offset-4"
        >
          Browse events
        </a>
      </div>
    )
  }

  return (
    <section aria-label="Your tickets" className="space-y-3">
      <h2 className="text-lg font-medium">
        You have {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
      </h2>
      <ul className={tickets.length === 1 ? 'grid gap-4' : 'grid gap-4 lg:grid-cols-2'}>
        {tickets.map((t) => (
          <li key={t.nfTokenId}>
            <TicketStub ticket={t} onGift={onGift} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function TicketStub({ ticket, onGift }: { ticket: OwnedTicket; onGift: (id: string) => void }) {
  const { event } = ticket
  const hue = hueFrom(event.slug)
  const when = new Date(event.startsAt)
  const state = STATE[ticket.status] ?? { label: ticket.status, tone: 'quiet' as const }
  const admission = [ticket.tier, ticket.seat].filter(Boolean).join(' · ')
  const canGift = ticket.status === 'MINTED'

  return (
    <article
      aria-label={`Ticket for ${event.title}`}
      className="relative grid overflow-hidden rounded-2xl text-white ring-1 ring-white/10 sm:grid-cols-[1fr_13rem]"
      style={{
        background: `linear-gradient(160deg,
          oklch(0.40 0.105 ${hue}) 0%,
          oklch(0.26 0.08 ${(hue + 25) % 360}) 60%,
          oklch(0.17 0.05 ${(hue + 45) % 360}) 100%)`,
      }}
    >
      <div className="relative flex gap-4 p-5 sm:gap-5 sm:p-6">
        {/* The artwork the holder bought, as a thumbnail, the way a printed ticket
            carries it. Laid behind the whole ticket it only showed the middle of a
            portrait image and muddied the type. */}
        {event.imageUrl && (
          <img
            src={posterUrl(event.imageUrl, 240)}
            alt=""
            loading="lazy"
            className="aspect-2/3 w-20 shrink-0 self-start rounded-md object-cover ring-1 ring-white/25 sm:w-28"
          />
        )}
        <div className="flex min-w-0 flex-col gap-4">
          <p className="font-mono text-[0.65rem] tracking-[0.22em] text-white/60 uppercase">Admit one</p>
          <h3 className="text-2xl leading-[1.1] font-semibold tracking-[-0.02em] sm:text-3xl">{event.title}</h3>
          <div className="space-y-1.5 text-sm text-white/80">
            <p className="flex items-center gap-2">
              <CalendarDays className="size-4 shrink-0 text-white/50" aria-hidden />
              <span>
                {dateFmt.format(when)} · {timeFmt.format(when)}
              </span>
            </p>
            {event.venue && (
              <p className="flex items-center gap-2">
                <MapPin className="size-4 shrink-0 text-white/50" aria-hidden />
                <span>{event.venue}</span>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* The tear line. Notches are page-coloured discs, so the stub reads as
          cut from the ticket on a light page and a dark one alike. */}
      <div className="relative flex flex-col justify-between gap-4 border-t border-dashed border-white/30 bg-black/20 p-5 sm:border-t-0 sm:border-l sm:p-6">
        <span className="bg-background absolute -top-3 -left-3 size-6 rounded-full" aria-hidden />
        <span
          className="bg-background absolute -top-3 -right-3 size-6 rounded-full sm:top-auto sm:right-auto sm:-bottom-3 sm:-left-3"
          aria-hidden
        />

        <div className="space-y-2">
          <span
            className={
              state.tone === 'valid'
                ? 'inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs font-medium text-emerald-200 ring-1 ring-emerald-300/30'
                : 'inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 ring-1 ring-white/15'
            }
          >
            {state.label}
          </span>
          <p className="text-sm text-white/80">{admission || 'General admission'}</p>
          {ticket.onLedger === false && (
            <p className="text-xs text-amber-200">
              We can't find this ticket in your wallet. Reload to check again.
            </p>
          )}
        </div>

        <Button
          size="sm"
          disabled={!canGift}
          onClick={() => onGift(ticket.nfTokenId)}
          aria-label={`Gift the ${event.title} ticket`}
          className="w-full bg-white text-neutral-950 hover:bg-white/90 disabled:bg-white/15 disabled:text-white/50"
        >
          Gift this ticket
        </Button>
      </div>
    </article>
  )
}
