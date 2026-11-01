/**
 * The moment a person approves something with a wallet they own.
 *
 * The page never asks the wallet to sign a hash it has not checked. `reviewSignRequest` decodes the
 * transaction, writes a plain summary from it, and recomputes the hash itself; if anything does not
 * add up, THERE IS NO APPROVE BUTTON, only the reason. What goes back to the server is the
 * signature alone: the server signs nothing and trusts no transaction from here.
 */
import { useEffect, useState } from 'react'
import { ApiError, submitSignature, type SignBlock } from '@/lib/api'
import type { Review, ReviewContext } from '@/lib/sign-review'
import { reviewer } from '@/lib/sign-review-loader'
import { useSignerRuntime } from '@/lib/signer-runtime'
import { Button } from '@/components/ui/button'

export function SignStep({
  uuid,
  sign,
  context,
  shownPrice,
  onSubmitted,
  onCancel,
}: {
  uuid: string
  sign: SignBlock
  /** Everything the review needs except the account, which is the signed-in wallet itself. */
  context: Omit<ReviewContext, 'account'>
  /**
   * The price as the page shows it (formatted by the caller), large under the title. Display only: the review never
   * sees it and nothing is checked against it. What is SIGNED is in the review's own lines, always shown under Details.
   */
  shownPrice?: string
  /** The server has the signature and has submitted it. The caller's own poll reports the outcome. */
  onSubmitted: (txid: string) => void
  onCancel: () => void
}) {
  const runtime = useSignerRuntime()
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wallet = runtime?.walletAddress ?? null
  // Primitives only in the dependency list (the polling discipline): `context` and `sign` are
  // objects the parent re-creates, and keying on them would re-run the check on every render.
  const key = JSON.stringify([uuid, wallet, context.hubworldDelegate, context.delegation, context.eventTitle, context.broker, context.action])
  useEffect(() => {
    if (!wallet) return
    let stale = false
    // Imported here, not at the top: the review needs the XRPL codec, which is large, and only
    // someone approving with their own wallet ever gets this far.
    void reviewer
      .load()
      .then((m) => m.reviewSignRequest(sign, { ...context, account: wallet }))
      .then((r) => {
        if (!stale) setReview(r)
      })
      .catch(() => {
        if (!stale) setReview({ ok: false, reason: 'We couldn’t check this request, so we won’t ask you to approve it.' })
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  async function approve() {
    if (!runtime || !review?.ok) return
    setBusy(true)
    setError(null)
    try {
      // The hash signed is the one `reviewSignRequest` recomputed and found equal to this one.
      const signature = await runtime.signHash(sign.account, sign.hash)
      const res = await submitSignature(uuid, signature)
      onSubmitted(res.txid)
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not approve that')
    } finally {
      setBusy(false)
    }
  }

  if (!runtime || !runtime.authenticated || !wallet) {
    return (
      <div className="space-y-3">
        <p className="text-sm">Sign in with your email again to approve this.</p>
        <div className="flex gap-2">
          <Button onClick={() => runtime?.openLogin()} disabled={!runtime?.ready}>
            Sign in
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  if (!review) return <p className="text-muted-foreground text-sm">Checking this request…</p>

  if (!review.ok) {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-destructive text-sm">{review.reason}</p>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-heading text-base font-semibold tracking-tight">{review.title}</h3>
        {shownPrice && <p className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">{shownPrice}</p>}
        {/* The exact transaction, from the decoded bytes. Always shown, even under a friendlier figure. */}
        <div className="text-muted-foreground mt-3 text-xs font-medium tracking-wide uppercase">Details</div>
        <ul className="text-muted-foreground mt-1 space-y-1.5 text-xs">
          {review.lines.map((line) => (
            <li key={line} className={line.startsWith('Authorising') || line.startsWith('Their wallet') ? 'font-mono text-xs break-all' : undefined}>
              {line}
            </li>
          ))}
        </ul>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={() => void approve()} disabled={busy}>
          {busy ? 'Approving…' : 'Approve'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
