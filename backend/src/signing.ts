/**
 * What a signature request looks like, independent of who signs it.
 *
 * HubWorld asks a user to sign a transaction and then waits to learn the outcome. Today
 * the only signer is Xaman (a QR or deep link, then a poll); an embedded wallet signs in
 * the browser with no second device. Routes and the payload store depend on THIS module
 * so adding a signer is a new implementation, not a change to eleven routes.
 *
 * Nothing here is new behaviour. The types were moved out of `xaman.ts` unchanged, which
 * keeps `xaman.ts` about Xaman and lets `SigningProvider` be the thing callers name.
 */
import type { PayloadFlow } from '@prisma/client'
import { xaman, tryGetPayload, asStub, SIGNIN_TTL_MINUTES } from './xaman.js'
import { prisma } from './prisma.js'
import { privyMode } from './env.js'
import { privySigner } from './privy-signing.js'
import { PRIVY_FLOW_RULES } from './privy-flows.js'

export type CreatedPayload = {
  uuid: string
  /** Deep link / universal URL that opens the request in the signer's app. */
  next: string
  /** PNG the frontend renders as a QR code. */
  qrPng: string
  /**
   * Present when the person signs in their own browser instead of scanning a code (Privy). The
   * full transaction so the page can show what is being approved, the hash it will be asked to
   * sign, and the account that must sign. Absent for Xaman.
   */
  sign?: { tx: Record<string, unknown>; hash: string; account: string }
}

export type PayloadStatus = {
  /** Xaman reports these independently; a payload can expire unsigned. */
  signed: boolean
  cancelled: boolean
  expired: boolean
  /** The r-address that signed, present only once signed. */
  account: string | null
  /**
   * Ledger transaction hash. Null for SignIn (a pseudo-transaction that is
   * never submitted) and null until a real transaction has been dispatched.
   */
  txid: string | null
}

/**
 * Who and what a payload is being spent on.
 *
 * `flow` is REQUIRED, and that is the whole enforcement mechanism for payload
 * accounting: the quota counts creations and cannot be reclaimed, so an
 * uncounted flow is real spend that never appears on the dashboard. Making it
 * required means a twelfth creation site cannot be added without saying what it
 * is — the compiler finds it, the way the `network` column made the compiler
 * find every create. Do not give it a default.
 */
export type PayloadAttribution = {
  flow: PayloadFlow
  /**
   * Who it is for, where that is known. Omitted for SIGNIN (there is no account
   * yet) and DOOR_CHECKIN (the attendee is unidentified until they sign).
   */
  userId?: string | null
}

export type PayloadOptions = PayloadAttribution & {
  /** Minutes until the request expires. */
  expireMinutes?: number
  /**
   * Pins which network the payload may be signed on. Without it a user whose
   * Xaman is set to mainnet would sign a testnet-intended mint against real
   * funds. Always set this for anything that touches the ledger.
   */
  forceNetwork?: 'TESTNET' | 'DEVNET' | 'MAINNET'
}

export interface SigningProvider {
  readonly mode: 'live' | 'stub'
  /** Generic payload creation — any txjson, signed by the user, on their device or in their wallet. */
  createPayload(txjson: Record<string, unknown>, opts: PayloadOptions): Promise<CreatedPayload>
  createSignInPayload(attribution: PayloadAttribution): Promise<CreatedPayload>
  getPayload(uuid: string): Promise<PayloadStatus | null>
  /** Free a slot against the account's unresolved-payload limit. */
  cancelPayload(uuid: string): Promise<boolean>
}

/** Which implementation signs for a user. Only Xaman exists today. */
export type SigningProviderKind = 'xaman'

/**
 * The provider that signs for a user.
 *
 * Takes no argument yet, deliberately: there is one provider, and a parameter nothing
 * varies on is a promise. The call sites go through here so that the day a second
 * provider exists, choosing between them happens in one place.
 */
export function providerFor(): SigningProvider {
  return xaman
}

/**
 * The flows a Privy user can complete: whatever `privy-flows.ts` lists, which is the only place that list is written.
 * Anything not on it is not built for Privy yet, and says so plainly rather than quietly asking Xaman to sign for a
 * wallet it does not hold.
 */
export const PRIVY_FLOWS: ReadonlySet<PayloadFlow> = new Set(PRIVY_FLOW_RULES.keys())

/** This person's wallet cannot do this yet. Not an error in the app; an honest "not built". */
export class SignerNotSupported extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignerNotSupported'
  }
}

/**
 * The signer for THIS person and THIS action.
 *
 * A signature request must go to the signer that holds the key, so the choice follows the
 * person's wallet, not a global setting. No user id (a sign-in, a door check-in) is always
 * Xaman. A Privy user is never silently handed a Xaman request: it would be asked of a wallet
 * that cannot hold their key, so anything Privy cannot do yet is refused with a reason.
 */
export async function signingFor(userId: string | null | undefined, flow: PayloadFlow): Promise<SigningProvider> {
  if (!userId) return xaman
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { signerKind: true } })
  if (wallet?.signerKind !== 'PRIVY') return xaman
  if (privyMode !== 'live') throw new SignerNotSupported('Email sign-in is switched off right now.')
  if (!PRIVY_FLOWS.has(flow)) {
    throw new SignerNotSupported('That is not available with email sign-in yet. Nothing was changed.')
  }
  return privySigner
}

/** The signing singleton (counted: every creation is attributed to a flow). */
export const signing: SigningProvider = xaman

export { tryGetPayload, asStub, SIGNIN_TTL_MINUTES }
