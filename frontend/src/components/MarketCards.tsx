/**
 * What the marketplace is made of: a ticket for sale, an auction that is live, and one of
 * your own listings.
 *
 * The marketplace used to be a single card of text rows, "Neon Rooftop Session, 24 XRP, from
 * @someone, Buy". A person deciding whether to spend money on somebody else's ticket needs
 * more than that, and every extra fact here is one the page already holds: the event's
 * poster, its date and venue, what the box office charged, and how the ask compares. Nothing
 * is invented, and where a fact is missing (an event with no box-office price, no poster) the
 * card leaves the line out rather than filling it with a guess.
 *
 * Rules carried from the rest of the system:
 * - Green means a live auction and nothing else, so "under face value" is words and an arrow,
 *   never green. Over and under are both plain facts, not good news and bad news.
 * - State is written down: a listing's state is always a word, never only a colour.
 * - A control appears only when it can work: Buy on a listing that is active.
 */
import { ArrowDown, ArrowUp, MapPin } from "lucide-react";
import { FallbackThumb } from "@/components/EventRow";
import { Button } from "@/components/ui/button";
import {
  type AuctionSummary,
  type EventSummary,
  type Fiat,
  type Listing,
} from "@/lib/api";
import { PRICE_UNAVAILABLE, formatFiat } from "@/lib/fiat";
import { faceDelta } from "@/lib/market";
import { posterSrcSet, posterUrl } from "@/lib/poster";

const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** The event's poster, or its generated date tile, at whatever size the parent gives it. */
function Poster({
  event,
  slug,
  title,
}: {
  event: EventSummary | undefined;
  slug: string;
  title: string;
}) {
  if (event?.imageUrl) {
    return (
      <img
        src={posterUrl(event.imageUrl, 480)}
        srcSet={posterSrcSet(event.imageUrl, 480)}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 size-full object-cover"
      />
    );
  }
  // Without an event record there is no date to draw, so the tile is a plain
  // hue derived from the slug rather than a date it would have to make up.
  return event ? (
    <FallbackThumb event={event} />
  ) : (
    <div
      aria-hidden
      data-fallback
      className="absolute inset-0"
      style={{
        background: `oklch(0.3 0.085 ${[...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)})`,
      }}
      title={title}
    />
  );
}

export function ListingCard({
  listing,
  event,
  busy,
  onBuy,
}: {
  listing: Listing;
  event: EventSummary | undefined;
  busy: boolean;
  onBuy: (l: Listing) => void;
}) {
  const { ticket } = listing;
  const delta = faceDelta(listing.priceDrops, event?.primaryPriceDrops);
  const hasFee = listing.platformFeeDrops !== "0";
  // Under the new terms the seller pays the fee out of the price, so the buyer pays exactly what is shown.
  const sellerPays = listing.feeModel === "SELLER_PAYS_V2";
  const buyFiat = listing.fiat?.buyerPaysDrops;
  const when = event ? new Date(event.startsAt) : null;
  const seat = [ticket.tier, ticket.seat].filter(Boolean).join(" · ");

  return (
    <li className="surface surface-hover flex flex-col overflow-hidden">
      <div className="relative aspect-16/10 w-full overflow-hidden">
        <Poster
          event={event}
          slug={ticket.event.slug}
          title={ticket.event.title}
        />
      </div>

      <div className="flex flex-1 flex-col p-4 sm:p-5">
        <h3 className="font-heading text-lg leading-snug font-semibold tracking-[-0.02em] text-balance">
          {ticket.event.title}
        </h3>
        {when && (
          <p className="text-muted-foreground mt-1 text-sm tabular-nums">
            {dayFmt.format(when)} · {timeFmt.format(when)}
          </p>
        )}
        {event?.venue && (
          <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{event.venue}</span>
          </p>
        )}
        {seat && <p className="text-muted-foreground mt-1 text-sm">{seat}</p>}

        <div className="mt-auto pt-5">
          {/* Fans see US$ only. With no fresh dollar figure the listing cannot be bought (it is priced in XRP). */}
          {buyFiat ? (
            <span className="text-2xl font-semibold tracking-[-0.03em] tabular-nums">{formatFiat(buyFiat)}</span>
          ) : (
            <span className="text-muted-foreground text-sm">{PRICE_UNAVAILABLE}</span>
          )}
          <p className="text-muted-foreground mt-0.5 min-h-5 text-xs tabular-nums">
            {!buyFiat
              ? null
              : sellerPays
                ? "All fees included"
                : hasFee && listing.fiat?.priceDrops && listing.fiat?.platformFeeDrops
                  ? `${formatFiat(listing.fiat.priceDrops)} + ${formatFiat(listing.fiat.platformFeeDrops)} platform fee`
                  : hasFee
                    ? "Includes the platform fee"
                    : "No platform fee"}
          </p>
          {delta && (
            <p className="mt-1 flex items-center gap-1 text-xs font-medium">
              {delta.direction === "over" && (
                <ArrowUp className="size-3.5" aria-hidden />
              )}
              {delta.direction === "under" && (
                <ArrowDown className="size-3.5" aria-hidden />
              )}
              {delta.label}
              {event?.fiat?.primaryPriceDrops && (
                <span className="text-muted-foreground font-normal tabular-nums">
                  {" "}
                  ({formatFiat(event.fiat.primaryPriceDrops)})
                </span>
              )}
            </p>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-muted-foreground min-w-0 truncate text-xs">
              Sold by {listing.seller}
            </span>
            <Button
              size="sm"
              disabled={busy || !buyFiat}
              onClick={() => onBuy(listing)}
              aria-label={buyFiat ? `Buy ${ticket.event.title} for ${formatFiat(buyFiat)}` : `Buy ${ticket.event.title} (price unavailable)`}
            >
              Buy
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function AuctionPlate({
  auction,
  event,
  onWatch,
}: {
  auction: AuctionSummary;
  event: EventSummary | undefined;
  onWatch: (slug: string) => void;
}) {
  const closes = new Date(auction.endsAt);
  const hasBids = auction.bidCount > 0;
  return (
    <li className="surface surface-live flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
      <div className="relative aspect-3/4 w-14 shrink-0 overflow-hidden rounded-lg sm:w-16">
        <Poster
          event={event}
          slug={auction.eventSlug}
          title={auction.eventTitle}
        />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex items-center gap-2">
          <span
            className="text-live relative flex size-1.5 shrink-0"
            aria-hidden
          >
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-current" />
          </span>
          <h3 className="truncate font-semibold tracking-tight">
            {auction.eventTitle}
          </h3>
        </div>
        <p className="text-muted-foreground mt-1 text-sm tabular-nums">
          {hasBids
            ? `${auction.fiat?.topBidDrops ? `Top bid ${formatFiat(auction.fiat.topBidDrops)} · ` : ""}${auction.bidCount} ${auction.bidCount === 1 ? "bid" : "bids"}`
            : auction.fiat?.reserveDrops
              ? `Reserve ${formatFiat(auction.fiat.reserveDrops)} · no bids yet`
              : "No bids yet"}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          Closes {dayFmt.format(closes)} at {timeFmt.format(closes)}
        </p>
      </div>
      <Button
        size="sm"
        onClick={() => onWatch(auction.eventSlug)}
        aria-label={`View live bidding for ${auction.eventTitle}`}
        className="w-full shrink-0 sm:w-auto"
      >
        Watch the bidding
      </Button>
    </li>
  );
}

/** A fan-facing amount: US$ only, or the plain note when there is no fresh price. */
function usd(fiat: Fiat | undefined): string {
  return fiat ? formatFiat(fiat) : PRICE_UNAVAILABLE.toLowerCase();
}

export function MyListingRow({
  listing,
  event,
  busy,
  onCheck,
  onWithdraw,
}: {
  listing: Listing;
  event: EventSummary | undefined;
  busy: boolean;
  onCheck: (l: Listing) => void;
  onWithdraw: (l: Listing) => void;
}) {
  const buying = listing.role === "buyer";
  return (
    <li className="surface flex flex-wrap items-center gap-x-3 gap-y-2 p-3.5">
      <div className="relative aspect-3/4 w-10 shrink-0 overflow-hidden rounded-md">
        <Poster
          event={event}
          slug={listing.ticket.event.slug}
          title={listing.ticket.event.title}
        />
      </div>
      <div className="min-w-0 flex-1 basis-32">
        <div className="truncate text-sm font-medium">
          {listing.ticket.event.title}
        </div>
        <div className="text-muted-foreground text-xs tabular-nums">
          {usd(listing.fiat?.priceDrops)}
          {listing.feeModel === "SELLER_PAYS_V2"
            ? !buying &&
              listing.fiat?.sellerReceivesDrops &&
              ` · you receive ${formatFiat(listing.fiat.sellerReceivesDrops)} before royalty`
            : listing.platformFeeDrops !== "0" &&
              listing.fiat?.buyerPaysDrops &&
              ` · buyer pays ${formatFiat(listing.fiat.buyerPaysDrops)}`}
          {" · "}
          {listing.state.replace("_", " ")}
          {buying ? " · buying" : ""}
        </div>
        {/* A bid that was let go: the server's own words, since the buyer is owed the reason. Shown only for a failure,
            because a sale still waiting on funds also carries a reason that is not news of a failure. */}
        {listing.state === "failed" && listing.reason && (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {listing.reason}
          </p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onCheck(listing)}
        >
          Check
        </Button>
        {!buying && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onWithdraw(listing)}
          >
            Withdraw
          </Button>
        )}
      </div>
    </li>
  );
}
