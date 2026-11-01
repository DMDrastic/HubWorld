/**
 * Signing out ends both sessions: HubWorld's, and the email wallet's.
 *
 * The email wallet remembers who signed in. Ending only HubWorld's session left that memory behind, so the email button went
 * straight back in as the same person and no one else could sign in on that browser. The wallet is signed out whatever the
 * server answered (a failed request must not leave the previous person's wallet signed in), and a wallet that cannot sign out must
 * never keep someone signed in to HubWorld, so its failure is not allowed to change the result.
 */
export async function signOutEverywhere<T>(server: () => Promise<T>, wallet: (() => Promise<void>) | null): Promise<T> {
  let result: T | undefined
  let failure: unknown
  let failed = false
  try {
    result = await server()
  } catch (err) {
    failed = true
    failure = err
  }
  try {
    await wallet?.()
  } catch {
    // Best effort: see above.
  }
  if (failed) throw failure
  return result as T
}
