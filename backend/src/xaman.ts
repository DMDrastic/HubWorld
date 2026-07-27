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
import { env, xamanMode } from './env.js'

const XAMAN_API = 'https://xumm.app/api/v1/platform'

/**
 * Payload lifetime. Sent to Xaman as `options.expire` AND used for our own
 * `expiresAt`, so the two clocks agree. When they disagree, a signature that
 * Xaman still considers valid gets rejected locally — which is exactly the bug
 * that made the first live sign-in look like it had failed.
 */
export const SIGNIN_TTL_MINUTES = 10

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

export type PayloadOptions = {
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
  createPayload(txjson: Record<string, unknown>, opts?: PayloadOptions): Promise<CreatedPayload>
  createSignInPayload(): Promise<CreatedPayload>
  getPayload(uuid: string): Promise<PayloadStatus | null>
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
    opts: PayloadOptions = {},
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
      throw new Error(`Xaman payload create failed: ${res.status} ${await res.text()}`)
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

  createSignInPayload(): Promise<CreatedPayload> {
    // No force_network: SignIn is a pseudo-transaction, never submitted to any
    // ledger, so pinning a network would only reject valid signers.
    return this.createPayload({ TransactionType: 'SignIn' })
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

  createSignInPayload(): Promise<CreatedPayload> {
    return this.createPayload()
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

// ----------------------------------------------------------------- export --

export const xaman: XamanClient =
  xamanMode === 'live' ? new LiveXamanClient() : new StubXamanClient()

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

/** Narrowing helper so routes can reach `simulate` only in stub mode. */
export function asStub(client: XamanClient): StubXamanClient | null {
  return client instanceof StubXamanClient ? client : null
}
