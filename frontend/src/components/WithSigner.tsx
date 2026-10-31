/**
 * Loads the Privy runtime around its children, only when it is both switched on and wanted here.
 *
 * `enabled` is decided by the caller from the server's policy and from who is looking: it is true
 * on the organizer area, and only when the deployment offers email sign-in. When it is false this
 * is a pass-through and the Privy chunk is never requested.
 */
import { lazy, Suspense, type ReactNode } from 'react'

const PrivyRuntime = lazy(() => import('@/components/PrivyRuntime'))

export function WithSigner({
  enabled,
  appId,
  children,
}: {
  enabled: boolean
  appId: string | undefined
  children: ReactNode
}) {
  if (!enabled || !appId) return <>{children}</>
  // Until the chunk arrives the children render without a runtime, so the email option simply is
  // not there yet rather than the page waiting on it.
  return (
    <Suspense fallback={children}>
      <PrivyRuntime appId={appId}>{children}</PrivyRuntime>
    </Suspense>
  )
}
