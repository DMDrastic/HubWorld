/**
 * "Your wallet needs XRP": shown instead of a cryptic failure when a purchase cannot go ahead because the wallet cannot pay.
 *
 * It names the address, says how much is needed and how much is there, and then does the one thing that fits the network:
 * on the TEST network, a button for free test XRP; on mainnet, the plain instruction to send real XRP. Whether the button
 * exists is the SERVER's answer (`canFund`), because the server is also what would refuse the request.
 */
import { useEffect, useState } from 'react'
import { ApiError, dropsToXrp, fetchWalletStatus, fundWallet, type WalletNeedsFunds } from '@/lib/api'
import { Button } from '@/components/ui/button'

/** How often to look for the test XRP after the faucet answers, and how long before letting them go on regardless. */
const ARRIVAL_POLL_MS = 2_000
const ARRIVAL_PATIENCE_MS = 60_000

export function WalletFunding({ info, onRetry }: { info: WalletNeedsFunds; onRetry: () => void }) {
  const [phase, setPhase] = useState<
    { kind: 'idle' } | { kind: 'asking' } | { kind: 'funded'; amountXrp: number } | { kind: 'failed'; reason: string }
  >({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  // "On its way" is not "arrived". Going on before the ledger shows it finds 0 XRP and puts the faucet button back, and
  // pressing that again spends another of the day's three. So the way on opens once the balance is there (or after a
  // minute, saying so). Held apart from `phase` and keyed on a NUMBER: a poll keyed on its own answers restarts itself.
  const [arrival, setArrival] = useState<'waiting' | 'arrived' | 'late'>('waiting')
  const fundedXrp = phase.kind === 'funded' ? phase.amountXrp : null

  useEffect(() => {
    if (fundedXrp === null) return
    let stopped = false
    let timer: number | undefined
    const started = Date.now()
    // The faucet's amount, in drops: a balance at least that big means it landed (a wallet asking for test XRP had less).
    const landed = BigInt(Math.round(fundedXrp * 1_000_000))
    setArrival('waiting')

    async function check() {
      if (stopped) return
      try {
        const s = await fetchWalletStatus()
        if (stopped) return
        // An unreadable ledger (no balance) is "not known yet", never "arrived".
        if (s.balanceDrops !== undefined && BigInt(s.balanceDrops) >= landed) {
          setArrival('arrived')
          return
        }
      } catch {
        // A blip is not an answer; keep looking.
      }
      if (Date.now() - started >= ARRIVAL_PATIENCE_MS) {
        setArrival('late')
        return
      }
      timer = window.setTimeout(() => void check(), ARRIVAL_POLL_MS)
    }

    timer = window.setTimeout(() => void check(), ARRIVAL_POLL_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [fundedXrp])

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
              <p className="text-sm" role="status">
                {arrival === 'arrived'
                  ? `${phase.amountXrp} test XRP is on its way. It has arrived.`
                  : arrival === 'late'
                    ? `${phase.amountXrp} test XRP is on its way, but it has not shown up yet. Try again in a moment.`
                    : `${phase.amountXrp} test XRP is on its way. It can take a few seconds to arrive.`}
              </p>
              <Button onClick={onRetry} disabled={arrival === 'waiting'}>
                {arrival === 'arrived' ? 'Continue' : arrival === 'late' ? 'Try again' : 'Waiting for it to arrive…'}
              </Button>
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
