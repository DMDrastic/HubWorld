/**
 * Find the person's XRPL wallet, or make one, without making a second.
 *
 * A Privy login can belong to someone who already has an XRPL wallet (another visit, another
 * device, a test run earlier). Asking Privy for a new one then fails with "already has one", and the
 * person is stuck. Two things made that easy to hit, and this is the one place both are handled:
 *
 *   - The user object can lag the moment login completes, so the first look finds nothing even
 *     though a wallet exists. Looking again after a short wait finds it.
 *   - So a refusal to create one is read as "it exists, look harder", not as a failure, and only a
 *     refusal that never resolves into a wallet is reported.
 */
export type FoundWallet = { address: string; publicKey: string }

type Existing = { address?: string; publicKey?: string; public_key?: string } | null

const keyOf = (w: NonNullable<Existing>) => (w.publicKey ?? w.public_key ?? '').toUpperCase()

export async function findOrCreateWallet(deps: {
  /** The wallet on the CURRENT user object, or null. Called again each time it is asked. */
  read: () => Existing
  create: () => Promise<Existing>
  /** Pause between looks; a parameter only so tests need not wait. */
  wait?: (ms: number) => Promise<void>
  looks?: number
  gapMs?: number
}): Promise<FoundWallet> {
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const looks = deps.looks ?? 6
  const gapMs = deps.gapMs ?? 300

  const have = (): FoundWallet | null => {
    const w = deps.read()
    return w?.address && keyOf(w) ? { address: w.address, publicKey: keyOf(w) } : null
  }

  const first = have()
  if (first) return first

  let failure: unknown = null
  try {
    const made = await deps.create()
    if (made?.address && keyOf(made)) return { address: made.address, publicKey: keyOf(made) }
    failure = new Error('Your wallet was created but its details were not returned.')
  } catch (err) {
    failure = err
  }

  // Creation failed, or came back without details. If the wallet is really there it will show up
  // on the user object shortly; give it a bounded chance to before reporting the failure.
  for (let i = 0; i < looks; i += 1) {
    await wait(gapMs)
    const found = have()
    if (found) return found
  }
  throw failure instanceof Error ? failure : new Error('Could not set up your wallet. Try again.')
}

type LinkedAccount = { type?: string; chainType?: string; address?: string; publicKey?: string; public_key?: string }

/**
 * The account's XRPL wallet on a Privy user: the FIRST one listed.
 *
 * A login can hold several (a second was made by mistake the first time this ran for real). The
 * list is in the order they were linked, so the first is the oldest, and the server picks the first
 * in the identity token by the same rule. They must agree: if they ever do not, the server's check
 * that the page's key belongs to the wallet it chose refuses the login instead of using the wrong one.
 */
export function firstXrplWallet(user: { linkedAccounts?: unknown[] } | null | undefined): LinkedAccount | null {
  const found = (user?.linkedAccounts ?? []).find((a) => {
    const w = a as LinkedAccount
    return w.type === 'wallet' && w.chainType === 'xrpl'
  })
  return (found as LinkedAccount | undefined) ?? null
}
