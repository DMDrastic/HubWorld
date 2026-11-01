/**
 * How a person approves a transaction: in their browser if the wallet is theirs, or by QR in Xaman.
 *
 * The server decides which by what it hands back. A request that carries a transaction (`sign`) belongs to a wallet the
 * person owns: it is shown in plain words, checked against what the page asked for, and signed here. One that does not is
 * a Xaman request, shown as a QR exactly as before. Every screen that asks for a signature goes through this, so there is
 * one place where "what do we show" is decided and no screen can forget the Privy case.
 */
import { useState } from 'react'
import { QrCode } from '@/components/QrCode'
import { SignStep } from '@/components/SignStep'
import { Button } from '@/components/ui/button'
import type { SignBlock } from '@/lib/api'
import type { ReviewAction } from '@/lib/sign-review'
import { usePolicy } from '@/lib/policy-context'

export type PromptPayload = {
  uuid: string
  next: string
  qrPng: string
  mode: 'live' | 'stub'
  sign?: SignBlock
}

export function SigningPrompt({
  payload,
  action,
  qrAlt,
  qrHint,
  qrClassName,
  onSubmitted,
  onCancel,
}: {
  payload: PromptPayload
  /** What the person asked for, as this page knows it: the transaction is checked against it. */
  action: ReviewAction
  qrAlt: string
  qrHint: string
  qrClassName?: string
  /** The server has the signature and has submitted it (own-wallet path only). The caller's own poll reports the outcome. */
  onSubmitted?: (txid: string) => void
  onCancel?: () => void
}) {
  const policy = usePolicy()
  const [approved, setApproved] = useState(false)

  if (payload.sign) {
    if (approved) {
      return <p className="text-muted-foreground text-center text-sm">Approved. Waiting for the network to confirm…</p>
    }
    return (
      <SignStep
        uuid={payload.uuid}
        sign={payload.sign}
        context={{ hubworldDelegate: null, broker: policy?.brokerAddress ?? null, action }}
        onSubmitted={(txid) => {
          setApproved(true)
          onSubmitted?.(txid)
        }}
        onCancel={() => onCancel?.()}
      />
    )
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <QrCode src={payload.qrPng} alt={qrAlt} next={payload.next} mode={payload.mode} className={qrClassName} />
      <p className="text-muted-foreground text-center text-sm">{qrHint}</p>
      {onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  )
}
