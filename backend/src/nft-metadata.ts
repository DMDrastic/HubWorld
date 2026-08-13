import { env } from './env.js'

/**
 * What a ticket looks like inside a wallet.
 *
 * Until this existed, every ticket was minted with **no URI at all** — no name,
 * no image, no description. A wallet cannot render that as anything but an
 * anonymous token from an unknown account, which is indistinguishable from the
 * spam NFTs airdropped across the XRPL, and Xaman flags it accordingly. A
 * ticketing product whose tickets are labelled a scam in the holder's own wallet
 * is broken in the way that matters most, however correct the ledger work is.
 *
 * ## Why the metadata is per EVENT, not per ticket
 *
 * The `NFTokenID` is derived BY THE LEDGER, so it does not exist when the mint
 * transaction is built — a per-ticket URI cannot name its own token. The event
 * is the natural unit anyway: same poster, same venue, same date. Per-seat
 * detail belongs in `attributes` on a future per-tier document, not here.
 *
 * ## Why the URI must be an absolute, public URL
 *
 * It is written on-ledger and read by wallets that have never heard of us. A
 * relative path or a `localhost` origin produces a token that renders nowhere,
 * for the life of the token.
 */

/** XLS-24, the convention wallets actually read. */
export type TicketMetadata = {
  schema: string
  nftType: 'ticket.v0'
  name: string
  description: string
  image?: string
  collection: { name: string; family: string }
  attributes: Array<{ trait_type: string; value: string }>
}

/**
 * The URI burned onto every ticket for an event.
 *
 * Kept short deliberately: the on-ledger limit is 256 BYTES and
 * `buildMintTx` throws above it, so a long slug plus a long origin is a mint
 * that fails at signing time rather than a truncated string.
 */
export function ticketMetadataUri(slug: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/events/${slug}/nft.json`
}

/**
 * Refuse to burn a development URL onto a real ledger.
 *
 * `DynamicNFT` is active, so a bad URI is now correctable with `NFTokenModify`
 * rather than permanent — but correcting it means another transaction per
 * ticket, signed by the organizer, against a payload quota that is already the
 * binding constraint. Cheaper to refuse than to fix a hundred of them.
 */
export function assertPublicBaseUrl(): void {
  const url = env.PUBLIC_BASE_URL
  if (env.XRPL_NETWORK !== 'mainnet') return
  if (/localhost|127\.0\.0\.1|\.local\b/i.test(url)) {
    throw new Error(
      `PUBLIC_BASE_URL is ${url}, which no wallet can reach. ` +
        'Set it to the public origin before minting on mainnet.',
    )
  }
}

export function ticketMetadata(event: {
  title: string
  description: string | null
  venue: string | null
  startsAt: Date
  imageUrl: string | null
}): TicketMetadata {
  return {
    schema: 'https://raw.githubusercontent.com/XRPLF/XRPL-Standards/master/XLS-24d/schema.json',
    nftType: 'ticket.v0',
    name: event.title,
    // The description is what a holder reads when deciding whether this is the
    // thing they paid for, so it names the event even when the organizer left
    // the field empty.
    description:
      event.description?.trim() ||
      `Admission to ${event.title}${event.venue ? ` at ${event.venue}` : ''}.`,
    ...(event.imageUrl ? { image: event.imageUrl } : {}),
    collection: { name: event.title, family: 'HubWorld tickets' },
    attributes: [
      { trait_type: 'Event', value: event.title },
      ...(event.venue ? [{ trait_type: 'Venue', value: event.venue }] : []),
      { trait_type: 'Date', value: event.startsAt.toISOString() },
    ],
  }
}
