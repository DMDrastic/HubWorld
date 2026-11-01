/**
 * "Your wallet needs XRP": shown instead of a cryptic failure when a purchase cannot go ahead because the wallet cannot pay.
 *
 * It names the address, says how much is needed and how much is there, and then does the one thing that fits the network:
 * on the TEST network, a button for free test XRP; on mainnet, the plain instruction to send real XRP. Whether the button
 * exists is the SERVER's answer (`canFund`), because the server is also what would refuse the request.
 */
import { useState } from 'react'
import { ApiError, dropsToXrp, fundWallet, type WalletNeedsFunds } from '@/lib/api'
import { Button } from '@/components/ui/button'

export function WalletFunding({ info, onRetry }: { info: WalletNeedsFunds; onRetry: () => void }) {
  const [phase, setPhase] = useState<
    { kind: 'idle' } | { kind: 'asking' } | { kind: 'funded'; amountXrp: number } | { kind: 'failed'; reason: string }
  >({ kind: 'idle' })
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(info.address)
      setCopied(true)
    } catch {
      // Copying is a convenience; the address is on the screen to be copied by hand.
    }
  }

  async function fund() {
    // Pressed twice, the second press finds the button already disabled: no second request.
    setPhase({ kind: 'asking' })
    try {
      const r = await fundWallet()
      setPhase({ kind: 'funded', amountXrp: r.amountXrp })
    } catch (err) {
      setPhase({ kind: 'failed', reason: err instanceof ApiError ? err.message : 'Could not get test XRP just now. Try again.' })
    }
  }

  const needed = dropsToXrp(info.neededDrops)
  return (
    <div className="space-y-3" role="alert">
      <div>
        <h3 className="font-heading text-base font-semibold tracking-tight">Your wallet needs XRP first</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          This wallet needs about {needed} XRP before it can pay for this. It has {dropsToXrp(info.haveDrops)} XRP.
        </p>
      </div>

      <div className="bg-muted/40 space-y-2 rounded-xl p-3.5">
        <div className="text-muted-foreground text-xs">Your wallet address</div>
        <div className="font-mono text-xs break-all">{info.address}</div>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy address'}
        </Button>
      </div>

      {info.canFund ? (
        <div className="space-y-2">
          {phase.kind === 'funded' ? (
            <>
              <p className="text-sm">{phase.amountXrp} test XRP is on its way. It can take a few seconds to arrive.</p>
              <Button onClick={onRetry}>Try again</Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">This is the test network, so the XRP is free and has no value.</p>
              {phase.kind === 'failed' && <p className="text-destructive text-sm">{phase.reason}</p>}
              <Button onClick={() => void fund()} disabled={phase.kind === 'asking'}>
                {phase.kind === 'asking' ? 'Asking…' : 'Get test XRP'}
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">Send at least {needed} XRP to this address, then check again.</p>
          <Button onClick={onRetry}>Check again</Button>
        </div>
      )}
    </div>
  )
}
