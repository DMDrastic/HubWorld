/**
 * Loads the Privy host beside the page, only when it is both switched on and wanted.
 *
 * `enabled` is decided by the caller from the server's policy. When it is false this is a pass-through and the Privy chunk is
 * never requested.
 *
 * The host is a SIBLING, not a wrapper. It reports its runtime upward into the context the rest of the app reads, so the page's
 * own tree is the same one before and after the chunk arrives: nothing under it remounts, and whatever a person had typed or
 * opened is kept. (A provider that wraps the page changes the page's parent when it loads, and React treats a new parent as a
 * new tree.) Until the host reports, the page simply sees no runtime and does not offer the email option.
 */
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { SignerRuntimeContext, type SignerRuntime } from '@/lib/signer-runtime'

const PrivyHost = lazy(() => import('@/components/PrivyRuntime'))

export function WithSigner({
  enabled,
  appId,
  children,
}: {
  enabled: boolean
  appId: string | undefined
  children: ReactNode
}) {
  const [runtime, setRuntime] = useState<SignerRuntime | null>(null)
  return (
    <SignerRuntimeContext.Provider value={runtime}>
      {children}
      {enabled && appId && (
        <Suspense fallback={null}>
          <PrivyHost appId={appId} onRuntime={setRuntime} />
        </Suspense>
      )}
    </SignerRuntimeContext.Provider>
  )
}
