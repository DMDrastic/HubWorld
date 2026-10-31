import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { QrCode } from "@/components/QrCode";
import {
  AuctionPlate,
  ListingCard,
  MyListingRow,
} from "@/components/MarketCards";
import { Segmented } from "@/components/Segmented";
import { cheapest, sortListings, type SortKey } from "@/lib/market";
import {
  ApiError,
  buyListing,
  cancelListing,
  createListing,
  openAuction,
  dropsToXrp,
  fetchInventory,
  fetchMarket,
  fetchMyListings,
  pollListing,
  xrpToDrops,
  type AuctionSummary,
  type EventSummary,
  type Listing,
  type ListingCreated,
  type OwnedTicket,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";

const POLL_MS = 2500;

type Phase =
  | { kind: "idle" }
  // `payload` is null when resuming a listing we already know the id of but
  // hold no QR for — same reason as GiftPanel.
  | {
      kind: "active";
      listingId: string;
      payload: ListingCreated | null;
      label: string;
    }
  | { kind: "failed"; reason: string };

/** States where a signature is still outstanding, so the QR belongs on screen. */
const NEEDS_SIGNATURE = new Set(["pending_offer", "active", "buyer_pending"]);

const MESSAGES: Record<Listing["state"], string> = {
  pending_offer: "Waiting for the listing to be signed…",
  active: "Listed. Waiting for a buyer.",
  buyer_pending: "Buyer committed — waiting for their signature…",
  settling: "Both offers placed. Hubworld is settling the sale…",
  sold: "Sold. The ticket and the money have moved.",
  cancelling: "Withdrawing — waiting for the ledger…",
  cancelled: "The listing was withdrawn.",
  expired: "The listing expired before it was signed.",
  failed: "The sale failed.",
};

/**
 * Mirrors the server's resale-cap check (`checkResalePrice` in
 * `resale-policy.ts`) for immediate feedback — the server re-validates
 * regardless, this just avoids a round trip for the common case.
 *
 * A listing's ask gets the platform fee added on top for the buyer, so it is
 * capped below the organizer's stated limit; an auction reserve/bid already
 * IS the buyer's total, so it compares against the limit directly. Same two
 * numbers the server computes — see tickets.ts.
 */
function checkResaleCap(
  selected: OwnedTicket | null,
  drops: string,
  mode: "sell" | "auction",
) {
  if (!selected) return;
  if (!selected.resaleAllowed) {
    throw new ApiError(
      selected.resaleBlockedReason ??
        "This event's organizer does not allow resale.",
    );
  }
  const max =
    mode === "sell"
      ? selected.maxListingPriceDrops
      : selected.maxAuctionReserveDrops;
  if (max !== null && BigInt(drops) > BigInt(max)) {
    throw new ApiError(
      `This event's organizer has limited resale prices to ${dropsToXrp(max)} XRP.`,
    );
  }
}

const SORTS = [
  { value: "soonest", label: "Soonest" },
  { value: "price", label: "Lowest price" },
] as const;

/**
 * The marketplace: what is for sale and what is being bid on, then the ticket you could sell.
 *
 * `events` and `auctions` are optional because the page worked without them (and the sell
 * form's tests render it alone): a listing with no matching event simply has no poster,
 * date or face value to show, and the card leaves those lines out.
 */
export function SellPanel({
  onChanged,
  events = [],
  auctions = [],
  onOpenAuction,
}: {
  onChanged: () => void;
  events?: EventSummary[];
  auctions?: AuctionSummary[];
  onOpenAuction?: (slug: string) => void;
}) {
  const sortId = useId();
  const [sort, setSort] = useState<SortKey>("soonest");
  const eventBySlug = useMemo(
    () => new Map(events.map((e) => [e.slug, e])),
    [events],
  );
  const [tickets, setTickets] = useState<OwnedTicket[]>([]);
  const [market, setMarket] = useState<Listing[]>([]);
  const [mine, setMine] = useState<Listing[]>([]);
  const [nfTokenId, setNfTokenId] = useState("");
  const [priceXrp, setPriceXrp] = useState("");
  const [mode, setMode] = useState<"sell" | "auction">("sell");
  const [minutes, setMinutes] = useState("60");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [inv, m, own] = await Promise.all([
        fetchInventory(true),
        fetchMarket(),
        fetchMyListings(),
      ]);
      // A ticket already committed elsewhere cannot be sold or auctioned: LISTED
      // has a live sell offer and IN_AUCTION is mid-auction.
      const sellable = inv.tickets.filter(
        (t) => t.status !== "LISTED" && t.status !== "IN_AUCTION",
      );
      setTickets(sellable);
      setMarket(m);
      setMine(own);
      // Picked from the FILTERED (sellable) list, not the raw inventory — the
      // raw list's first entry can be a ticket this refresh just excluded
      // (just listed, just auctioned), which would silently keep the form
      // pointed at it. Also re-picks whenever the current selection drops out
      // of the sellable set, not just on first mount: listing one ticket and
      // then listing a second, in the same visit with no reload, used to
      // resubmit the first ticket's id again and 409 as "already listed".
      setNfTokenId((cur) =>
        cur && sellable.some((t) => t.nfTokenId === cur)
          ? cur
          : (sellable[0]?.nfTokenId ?? ""),
      );
    } catch {
      // Non-fatal.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Eligibility belongs to the SELECTED ticket, since it depends on that
  // ticket's event and holder.
  const selected = tickets.find((t) => t.nfTokenId === nfTokenId) ?? null;
  const auctionAllowed = selected?.canAuction ?? false;

  // Selecting a ticket that cannot be auctioned must not strand the form in
  // auction mode, or the user submits something the server will refuse.
  useEffect(() => {
    if (mode === "auction" && selected && !auctionAllowed) setMode("sell");
  }, [mode, selected, auctionAllowed]);

  const activeId = phase.kind === "active" ? phase.listingId : null;

  // Keyed on a primitive, and the polled state lives outside `phase` — putting
  // it inside makes the dependency change every tick and turns this into a tight
  // request loop. See GiftPanel.
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    let timer: number;

    const tick = async () => {
      if (stopped) return;
      try {
        const next = await pollListing(activeId);
        if (stopped) return;
        setListing(next);

        if (["sold", "cancelled", "expired", "failed"].includes(next.state)) {
          void refresh();
          onChanged();
          return;
        }
        timer = window.setTimeout(tick, POLL_MS);
      } catch (err) {
        if (stopped) return;
        setPhase({
          kind: "failed",
          reason: err instanceof ApiError ? err.message : "Polling failed",
        });
      }
    };

    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [activeId, refresh, onChanged]);

  function track(
    listingId: string,
    payload: ListingCreated | null,
    label: string,
  ) {
    setListing(null);
    setPhase({ kind: "active", listingId, payload, label });
  }

  async function list() {
    setBusy(true);
    try {
      const drops = xrpToDrops(priceXrp);
      if (BigInt(drops) <= 0n) throw new ApiError("Enter a price above zero");
      checkResaleCap(selected, drops, "sell");
      const payload = await createListing(nfTokenId, drops);
      track(payload.listingId, payload, `List for ${priceXrp} XRP`);
    } catch (err) {
      setPhase({
        kind: "failed",
        reason:
          err instanceof ApiError
            ? err.message
            : "Could not create the listing",
      });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Opening an auction is one signature that creates both the bidding rules and
   * the holder's sell offer. We poll the LISTING, because the auction only goes
   * live once that offer reaches the ledger.
   */
  async function startAuction() {
    setBusy(true);
    try {
      const drops = xrpToDrops(priceXrp);
      if (BigInt(drops) <= 0n) throw new ApiError("Enter a reserve above zero");
      checkResaleCap(selected, drops, "auction");
      const result = await openAuction(nfTokenId, drops, Number(minutes));
      track(
        result.listingId,
        { ...result, priceDrops: drops },
        `Auction at ${priceXrp} XRP reserve`,
      );
    } catch (err) {
      setPhase({
        kind: "failed",
        reason:
          err instanceof ApiError ? err.message : "Could not open the auction",
      });
    } finally {
      setBusy(false);
    }
  }

  async function buy(l: Listing) {
    setBusy(true);
    try {
      const payload = await buyListing(l.listingId);
      track(
        l.listingId,
        payload,
        `Buy for ${dropsToXrp(l.buyerPaysDrops)} XRP`,
      );
    } catch (err) {
      setPhase({
        kind: "failed",
        reason:
          err instanceof ApiError
            ? err.message
            : "Could not start the purchase",
      });
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(listingId: string) {
    setBusy(true);
    try {
      const result = await cancelListing(listingId);
      if ("uuid" in result) {
        track(listingId, result, "Withdraw listing");
      } else {
        setPhase({ kind: "idle" });
        void refresh();
        onChanged();
      }
    } catch (err) {
      setPhase({
        kind: "failed",
        reason: err instanceof ApiError ? err.message : "Could not withdraw",
      });
    } finally {
      setBusy(false);
    }
  }

  const forSale = sortListings(market, eventBySlug, sort);
  const lowest = cheapest(market);

  return (
    <div className="space-y-10">
      {phase.kind === "idle" && (
        <>
          {/* What the market holds right now, in a line. Only facts it has: a count of
              listings, a count of live auctions, the lowest total a buyer would pay. */}
          <p className="text-muted-foreground -mt-6 text-sm tabular-nums">
            {market.length} {market.length === 1 ? "ticket" : "tickets"} for
            sale
            {" · "}
            {auctions.length} live{" "}
            {auctions.length === 1 ? "auction" : "auctions"}
            {lowest && <> · from {dropsToXrp(lowest)} XRP</>}
          </p>

          {auctions.length > 0 && onOpenAuction && (
            <section
              className="space-y-3"
              aria-labelledby={`${sortId}-auctions`}
            >
              <h2
                id={`${sortId}-auctions`}
                className="text-lg font-semibold tracking-[-0.01em]"
              >
                Live auctions
              </h2>
              <ul className="space-y-3">
                {auctions.map((a) => (
                  <AuctionPlate
                    key={a.id}
                    auction={a}
                    event={eventBySlug.get(a.eventSlug)}
                    onWatch={onOpenAuction}
                  />
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-4" aria-labelledby={`${sortId}-sale`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2
                id={`${sortId}-sale`}
                className="text-lg font-semibold tracking-[-0.01em]"
              >
                For sale
              </h2>
              {market.length > 1 && (
                <Segmented
                  label="Sort tickets for sale"
                  options={SORTS}
                  value={sort}
                  onChange={setSort}
                  idBase={`${sortId}-sort`}
                  panelId={`${sortId}-grid`}
                />
              )}
            </div>
            {market.length === 0 ? (
              <div className="surface px-6 py-12 text-center">
                <h3 className="font-semibold tracking-tight">
                  Nothing for sale right now
                </h3>
                <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
                  Tickets that holders list appear here. Every resale pays the
                  organizer their royalty automatically, and the money never
                  passes through HubWorld.
                </p>
              </div>
            ) : (
              <div
                role="tabpanel"
                id={`${sortId}-grid`}
                aria-labelledby={`${sortId}-sort-${sort}`}
              >
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {forSale.map((l) => (
                    <ListingCard
                      key={l.listingId}
                      listing={l}
                      event={eventBySlug.get(l.ticket.event.slug)}
                      busy={busy}
                      onBuy={(x) => void buy(x)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </section>

          {mine.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold tracking-[-0.01em]">
                Your listings
              </h2>
              <ul className="space-y-2">
                {mine.map((l) => (
                  <MyListingRow
                    key={l.listingId}
                    listing={l}
                    event={eventBySlug.get(l.ticket.event.slug)}
                    busy={busy}
                    onCheck={(x) =>
                      track(x.listingId, null, x.ticket.event.title)
                    }
                    onWithdraw={(x) => void withdraw(x.listingId)}
                  />
                ))}
              </ul>
            </section>
          )}

          <section className="surface space-y-3 p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-lg font-semibold tracking-[-0.01em]">
                {mode === "sell" ? "Sell a ticket" : "Auction a ticket"}
              </h2>
              {(auctionAllowed || mode === "auction") && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
                  onClick={() => setMode(mode === "sell" ? "auction" : "sell")}
                >
                  {mode === "sell"
                    ? "auction instead"
                    : "sell at a fixed price instead"}
                </button>
              )}
            </div>
            <p className="text-muted-foreground max-w-xl text-sm leading-relaxed">
              The organizer&rsquo;s royalty is taken by the ledger itself, and
              HubWorld brokers the match, so the money never passes through us.
            </p>
            {tickets.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No unlisted tickets to sell.
              </p>
            ) : (
              <>
                <select
                  value={nfTokenId}
                  onChange={(e) => setNfTokenId(e.target.value)}
                  aria-label="ticket to sell"
                  className={fieldClass}
                >
                  {tickets.map((t) => (
                    <option key={t.nfTokenId} value={t.nfTokenId}>
                      {[t.event.title, t.tier, t.seat]
                        .filter(Boolean)
                        .join(" · ")}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <Input
                    value={priceXrp}
                    onChange={(e) => setPriceXrp(e.target.value)}
                    placeholder={
                      mode === "sell" ? "Price in XRP" : "Reserve in XRP"
                    }
                    inputMode="decimal"
                    aria-label={
                      mode === "sell" ? "price in XRP" : "reserve in XRP"
                    }
                  />
                  {mode === "auction" && (
                    <Input
                      value={minutes}
                      onChange={(e) => setMinutes(e.target.value)}
                      placeholder="Minutes"
                      inputMode="numeric"
                      aria-label="auction length in minutes"
                      className="w-28"
                    />
                  )}
                  <Button
                    disabled={busy || !nfTokenId || !priceXrp.trim()}
                    onClick={() =>
                      void (mode === "sell" ? list() : startAuction())
                    }
                  >
                    {busy ? "…" : mode === "sell" ? "List" : "Open"}
                  </Button>
                </div>
                {selected && !selected.resaleAllowed && (
                  <p className="text-destructive text-xs">
                    {selected.resaleBlockedReason}
                  </p>
                )}
                {selected?.resaleAllowed &&
                  (() => {
                    const max =
                      mode === "sell"
                        ? selected.maxListingPriceDrops
                        : selected.maxAuctionReserveDrops;
                    if (max === null) return null;
                    // A ticket that cost nothing cannot be sold for money, whatever the organizer's policy says.
                    if (max === "0" && selected.resaleCapSource === "PAID") {
                      return (
                        <p className="text-muted-foreground text-xs">
                          This ticket was free, so it can't be sold for money.
                          You can still give it to someone.
                        </p>
                      );
                    }
                    // The new rule: nobody resells for more than was paid. Said as what it is, not as the
                    // organizer's doing, because it isn't.
                    if (selected.resaleCapSource === "PAID") {
                      return (
                        <p className="text-muted-foreground text-xs">
                          Capped at what the buyer paid:{" "}
                          {mode === "sell" ? "list for" : "reserve"} up to{" "}
                          {dropsToXrp(max)} XRP
                        </p>
                      );
                    }
                    return (
                      <p className="text-muted-foreground text-xs">
                        Organizer resale limit:{" "}
                        {mode === "sell" ? "list for" : "reserve"} up to{" "}
                        {dropsToXrp(max)} XRP
                        {selected.faceValueDrops
                          ? ` (face value ${dropsToXrp(selected.faceValueDrops)} XRP)`
                          : ""}
                      </p>
                    );
                  })()}
                {mode === "sell" && selected?.auctionBlockedReason && (
                  <p className="text-muted-foreground text-xs">
                    {selected.auctionBlockedReason}
                  </p>
                )}
                {mode === "auction" && (
                  <p className="text-muted-foreground text-xs">
                    One signature opens the auction and places your sell offer.
                    The reserve is the minimum — bids above it pay you more, and
                    the ticket cannot be bought outright while the auction runs.
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}

      {phase.kind === "active" && (
        <div className="surface flex flex-col items-center gap-3 p-6">
          <div className="text-sm font-medium">{phase.label}</div>

          {phase.payload !== null &&
            (listing === null || NEEDS_SIGNATURE.has(listing.state)) && (
              <>
                <QrCode
                  src={phase.payload.qrPng}
                  alt="Xaman signing QR code"
                  next={phase.payload.next}
                  mode={phase.payload.mode}
                />
                <p className="text-muted-foreground text-center text-sm">
                  Scan in Xaman to sign.
                </p>
              </>
            )}

          {listing && (
            <>
              <Badge variant="secondary">
                {listing.state.replace("_", " ")}
              </Badge>
              <p className="text-center text-sm">
                {listing.state === "failed"
                  ? (listing.reason ?? MESSAGES.failed)
                  : MESSAGES[listing.state]}
              </p>
              {listing.state === "sold" && (
                <div className="bg-muted/40 w-full space-y-1 rounded-xl p-3.5 text-xs">
                  <div className="text-muted-foreground">seller receives</div>
                  <div>
                    {dropsToXrp(listing.priceDrops)} XRP minus the royalty
                  </div>
                  <div className="text-muted-foreground mt-1">platform fee</div>
                  <div>{dropsToXrp(listing.platformFeeDrops)} XRP</div>
                </div>
              )}
            </>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPhase({ kind: "idle" })}
          >
            Done
          </Button>
        </div>
      )}

      {phase.kind === "failed" && (
        <div className="surface space-y-3 p-6">
          <p className="text-destructive text-sm">{phase.reason}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPhase({ kind: "idle" })}
          >
            Start over
          </Button>
        </div>
      )}
    </div>
  );
}
