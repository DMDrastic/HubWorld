/**
 * Xaman (formerly XUMM) platform client.
 *
 * Two implementations behind one interface:
 *   - live: talks to the Xaman platform API using the key/secret pair
 *   - stub: fabricates payloads locally so the sign-in loop is fully
 *           developable and testable before you have a developer account
 *
 * The API SECRET is backend-only. It must never be sent to the frontend, and
 * nothing in this module should ever be imported from frontend/.
 *
 * Endpoint shapes follow the Xaman platform API as of writing — verify against
 * current docs before going live, since the platform evolves.
 */
import type { PayloadFlow } from '@prisma/client'
import { env, xamanMode } from './env.js'

const XAMAN_API = 'https://xumm.app/api/v1/platform'

/**
 * Payload lifetime. Sent to Xaman as `options.expire` AND used for our own
 * `expiresAt`, so the two clocks agree. When they disagree, a signature that
 * Xaman still considers valid gets rejected locally — which is exactly the bug
 * that made the first live sign-in look like it had failed.
 *
 * Kept SHORT because an unresolved payload holds a slot against the account's
 * open-payload cap until it expires. A QR is either scanned within a minute or
 * abandoned, so ten minutes bought nothing and reclaimed slots three times more
 * slowly than necessary.
 */
export const SIGNIN_TTL_MINUTES = 3

export type CreatedPayload = {
  uuid: string
  /** Deep link / universal URL that opens the payload in Xaman. */
  next: string
  /** PNG the frontend renders as a QR code. */
  qrPng: string
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
 * Xaman rate-limited us. Transient and carries no information about the
 * payload, so polls should report "still pending" instead of an error — the
 * user may well have already signed.
 */
export class XamanRateLimited extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(`Xaman rate limit hit; retry in ${retryAfterSeconds}s`)
    this.name = 'XamanRateLimited'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * The Xaman application has exhausted its payload quota.
 *
 * Measured, after an initially wrong guess: the number in Xaman's message RISES
 * as more payloads are created (67 -> 77), so it is a count of payloads created,
 * not a cap on how many are open. Cancelling does NOT reclaim quota — DELETE on a
 * resolved payload returns 404 and Xaman has already discarded it, yet it still
 * counts.
 *
 * So this is not recoverable in code. It needs a higher application limit, or
 * fresh credentials. What code CAN do is consume the quota more slowly, which is
 * why sign-in reuses an outstanding payload instead of minting one per click.
 */
export class XamanPayloadLimit extends Error {
  constructor(detail: string) {
    super(`Xaman payload limit reached: ${detail}`)
    this.name = 'XamanPayloadLimit'
  }
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
  /** Minutes until Xaman expires the payload. */
  expireMinutes?: number
  /**
   * Pins which network the payload may be signed on. Without it a user whose
   * Xaman is set to mainnet would sign a testnet-intended mint against real
   * funds. Always set this for anything that touches the ledger.
   */
  forceNetwork?: 'TESTNET' | 'DEVNET' | 'MAINNET'
}

export interface XamanClient {
  readonly mode: 'live' | 'stub'
  /** Generic payload creation — any txjson, signed on the user's device. */
  createPayload(txjson: Record<string, unknown>, opts: PayloadOptions): Promise<CreatedPayload>
  createSignInPayload(attribution: PayloadAttribution): Promise<CreatedPayload>
  getPayload(uuid: string): Promise<PayloadStatus | null>
  /** Free a slot against the account's unresolved-payload limit. */
  cancelPayload(uuid: string): Promise<boolean>
}

// ------------------------------------------------------------------- live --

class LiveXamanClient implements XamanClient {
  readonly mode = 'live' as const

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': env.XAMAN_API_KEY!,
      'X-API-Secret': env.XAMAN_API_SECRET!,
    }
  }

  async createPayload(
    txjson: Record<string, unknown>,
    opts: PayloadOptions,
  ): Promise<CreatedPayload> {
    try {
      return await this.createOnce(txjson, opts)
    } catch (err) {
      if (!(err instanceof XamanPayloadLimit)) throw err

      // Try reclaiming once. This is known NOT to help against a quota — the
      // count only grows — but it costs one call and covers the case where the
      // limit really is about open payloads on a differently-configured
      // application. If nothing was freed, the error stands.
      const { cancelAbandonedPayloads } = await import('./payload-store.js')
      const freed = await cancelAbandonedPayloads(100, true)
      if (freed === 0) throw err
      return this.createOnce(txjson, opts)
    }
  }

  /** Attribution is not Xaman's business — only the wire options are. */
  private async createOnce(
    txjson: Record<string, unknown>,
    opts: Pick<PayloadOptions, 'expireMinutes' | 'forceNetwork'>,
  ): Promise<CreatedPayload> {
    const res = await fetch(`${XAMAN_API}/payload`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        txjson,
        options: {
          expire: opts.expireMinutes ?? SIGNIN_TTL_MINUTES,
          ...(opts.forceNetwork ? { force_network: opts.forceNetwork } : {}),
        },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      // Xaman answers 400 with the real code nested in the body, so the HTTP
      // status alone is misleading. "Max payloads exceeded" means the account is
      // full of UNRESOLVED payloads — a capacity problem, not a bad request, and
      // it must not read as an internal error.
      if (/max payloads/i.test(text) || /"code":\s*429/.test(text)) {
        throw new XamanPayloadLimit(text)
      }
      throw new Error(`Xaman payload create failed: ${res.status} ${text}`)
    }

    const body = (await res.json()) as {
      uuid: string
      next?: { always?: string }
      refs?: { qr_png?: string }
    }

    if (!body.uuid || !body.next?.always || !body.refs?.qr_png) {
      throw new Error('Xaman returned an unexpected payload shape')
    }

    return { uuid: body.uuid, next: body.next.always, qrPng: body.refs.qr_png }
  }

  createSignInPayload(attribution: PayloadAttribution): Promise<CreatedPayload> {
    // No force_network: SignIn is a pseudo-transaction, never submitted to any
    // ledger, so pinning a network would only reject valid signers.
    return this.createPayload({ TransactionType: 'SignIn' }, attribution)
  }

  /**
   * Cancel an unresolved payload, freeing a slot against the account limit.
   * Already-resolved payloads cannot be cancelled, which is harmless.
   */
  async cancelPayload(uuid: string): Promise<boolean> {
    const res = await fetch(`${XAMAN_API}/payload/${uuid}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    return res.ok
  }

  async getPayload(uuid: string): Promise<PayloadStatus | null> {
    const res = await fetch(`${XAMAN_API}/payload/${uuid}`, { headers: this.headers() })

    if (res.status === 404) return null
    // Rate limiting is transient and says nothing about the payload. Callers
    // must treat it as "unknown, ask again" rather than as a failure, or a
    // signature that already landed looks like a crashed flow.
    if (res.status === 429) {
      throw new XamanRateLimited(Number(res.headers.get('retry-after')) || 5)
    }
    if (!res.ok) {
      throw new Error(`Xaman payload fetch failed: ${res.status}`)
    }

    const body = (await res.json()) as {
      meta?: { signed?: boolean; cancelled?: boolean; expired?: boolean }
      response?: { account?: string | null; txid?: string | null }
    }

    return {
      signed: body.meta?.signed === true,
      cancelled: body.meta?.cancelled === true,
      expired: body.meta?.expired === true,
      account: body.response?.account ?? null,
      txid: body.response?.txid ?? null,
    }
  }
}

// ------------------------------------------------------------------- stub --

/**
 * In-memory stand-in. Payloads start unsigned and only resolve when
 * `simulateSign` is called via the dev-only endpoint, which mirrors the real
 * timing: create → poll → poll → resolved.
 */
class StubXamanClient implements XamanClient {
  readonly mode = 'stub' as const
  private readonly payloads = new Map<string, PayloadStatus>()

  async createPayload(): Promise<CreatedPayload> {
    const uuid = crypto.randomUUID()
    this.payloads.set(uuid, {
      signed: false,
      cancelled: false,
      expired: false,
      account: null,
      txid: null,
    })
    return {
      uuid,
      next: `hubworld-stub://sign/${uuid}`,
      // Inline SVG placeholder — no external fetch, no QR dependency.
      qrPng: `data:image/svg+xml;utf8,${encodeURIComponent(stubQrSvg())}`,
    }
  }

  // Both ignore their arguments: a stub has no wire format and no quota to
  // account for. Declaring fewer parameters still satisfies the interface.
  createSignInPayload(): Promise<CreatedPayload> {
    return this.createPayload()
  }

  async cancelPayload(uuid: string): Promise<boolean> {
    return this.payloads.delete(uuid)
  }

  async getPayload(uuid: string): Promise<PayloadStatus | null> {
    return this.payloads.get(uuid) ?? null
  }

  /**
   * Dev-only: pretend the user signed (or rejected) in the Xaman app.
   *
   * `txid` is supplied by the caller because a stub cannot mint on a real
   * ledger. Stub mints therefore never produce a genuine NFTokenID — the
   * mint route treats a stub signature as un-verifiable and says so.
   */
  simulate(
    uuid: string,
    account: string,
    outcome: 'sign' | 'reject',
    txid: string | null = null,
  ): boolean {
    const p = this.payloads.get(uuid)
    if (!p) return false
    if (outcome === 'reject') {
      this.payloads.set(uuid, { ...p, cancelled: true })
    } else {
      this.payloads.set(uuid, { ...p, signed: true, account, txid })
    }
    return true
  }
}

function stubQrSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">',
    '<rect width="180" height="180" fill="#e5e5e5"/>',
    '<text x="90" y="85" text-anchor="middle" font-family="monospace" font-size="13" fill="#555">STUB MODE</text>',
    '<text x="90" y="105" text-anchor="middle" font-family="monospace" font-size="10" fill="#777">no real QR</text>',
    '</svg>',
  ].join('')
}

// --------------------------------------------------------------- counting --

/**
 * Records every payload the moment it is created, then gets out of the way.
 *
 * ## Why a wrapper rather than a line in each route
 *
 * The Xaman quota counts payloads CREATED and cannot be reclaimed, so a flow
 * that forgets to count is real spend that never appears in the numbers — and
 * there are eleven creation sites. Wrapping the client makes counting the only
 * way to create: there is no unwrapped `xaman` exported to reach past it.
 *
 * It also decorates rather than extends, so it is signer-agnostic. A second
 * signer added at the seam (Crossmark, GemWallet — see ROADMAP §3) is counted
 * without touching this file, because what is being measured is *signature
 * requests we made*, not *calls to Xaman*.
 *
 * ## It absorbs `trackPayload`
 *
 * Every route used to follow creation with `await trackPayload(uuid)` so webhook
 * reconciliation could find the payload. That is the same row this writes, and
 * doing it here closes a real ordering gap: registration now happens before the
 * route even holds the payload, rather than a few statements later, so a
 * signature can no longer land in the window between the two.
 */
class CountingSigner implements XamanClient {
  constructor(private readonly inner: XamanClient) {}

  get mode() {
    return this.inner.mode
  }

  /**
   * `live` is the real Xaman; anything else is the local stand-in, which costs
   * no quota. Recorded as a name rather than a mode so a second signer is
   * distinguishable in the report without a migration.
   */
  private get signerName(): string {
    return this.inner.mode === 'live' ? 'xaman' : 'stub'
  }

  async createPayload(
    txjson: Record<string, unknown>,
    opts: PayloadOptions,
  ): Promise<CreatedPayload> {
    const created = await this.inner.createPayload(txjson, opts)
    await this.record(created.uuid, opts)
    return created
  }

  async createSignInPayload(attribution: PayloadAttribution): Promise<CreatedPayload> {
    const created = await this.inner.createSignInPayload(attribution)
    await this.record(created.uuid, attribution)
    return created
  }

  private async record(uuid: string, attribution: PayloadAttribution): Promise<void> {
    // Lazily imported: this module is the seam and must not drag Prisma into
    // the static graph of anything that only wants to build a transaction.
    const { recordPayloadCreation } = await import('./payload-metrics.js')
    await recordPayloadCreation({
      uuid,
      flow: attribution.flow,
      signer: this.signerName,
      userId: attribution.userId ?? null,
    })
  }

  getPayload(uuid: string): Promise<PayloadStatus | null> {
    return this.inner.getPayload(uuid)
  }

  cancelPayload(uuid: string): Promise<boolean> {
    return this.inner.cancelPayload(uuid)
  }

  /**
   * The wrapped client, for `asStub`'s `instanceof` check only.
   *
   * NOT an escape hatch for creating payloads. Reaching past the wrapper spends
   * quota that no report can see, which is the exact hole this class closes.
   */
  unwrap(): XamanClient {
    return this.inner
  }
}

/**
 * Wrap any signer so its creations are counted.
 *
 * Exported so the counting can be tested against a fake signer. That is not a
 * convenience: the alternative is testing it through the exported `xaman`, which
 * in a checkout with real credentials means the test suite CREATES REAL PAYLOADS
 * every run — burning the very quota this whole mechanism exists to conserve.
 */
export function withPayloadCounting(client: XamanClient): XamanClient {
  return new CountingSigner(client)
}

// ----------------------------------------------------------------- export --

export const xaman: XamanClient = withPayloadCounting(
  xamanMode === 'live' ? new LiveXamanClient() : new StubXamanClient(),
)

/**
 * `getPayload`, but a rate limit becomes the sentinel `'unavailable'` rather
 * than a throw.
 *
 * Every poll route wants the same thing here: "we could not find out, so keep
 * reporting pending." Letting the 429 propagate turns a transient limit into a
 * 500 and makes an already-signed transaction look like a crash — which is
 * exactly what happened the first time a gift was signed.
 */
export async function tryGetPayload(
  uuid: string,
): Promise<PayloadStatus | null | 'unavailable'> {
  // Delegated so every poll site benefits from the webhook without being
  // rewritten. Imported lazily because payload-store imports this module.
  const { resolvePayload } = await import('./payload-store.js')
  return resolvePayload(uuid)
}

/**
 * Narrowing helper so routes can reach `simulate` only in stub mode.
 *
 * Unwraps first: the exported client is a `CountingSigner`, so a bare
 * `instanceof StubXamanClient` would answer null in stub mode and silently
 * disable the simulate endpoint the whole e2e suite depends on.
 */
export function asStub(client: XamanClient): StubXamanClient | null {
  const target = client instanceof CountingSigner ? client.unwrap() : client
  return target instanceof StubXamanClient ? target : null
}
