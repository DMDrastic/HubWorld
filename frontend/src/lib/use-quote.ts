/**
 * The display estimate for amounts the page worked out or someone is typing. The server converts; this only asks,
 * after a short pause, and keys on the amounts themselves (a primitive), never on its own result.
 *
 * An estimate is only ever returned for the amounts it was asked about: while a new one is on its way the answer is
 * empty, so a figure for the previous amount is never shown beside the new one.
 */
import { useEffect, useState } from 'react'
import { quotePrices, type Fiat } from '@/lib/api'

const PAUSE_MS = 300

export function useQuote(drops: Array<string | null | undefined>, slug?: string): Record<string, Fiat> {
  const key = drops.filter((d): d is string => typeof d === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(d)).join(',')
  const [answer, setAnswer] = useState<{ key: string; fiat: Record<string, Fiat> }>({ key: '', fiat: {} })

  useEffect(() => {
    if (!key) return
    let stopped = false
    const timer = window.setTimeout(() => {
      quotePrices(key.split(','), slug)
        .then((fiat) => {
          if (!stopped) setAnswer({ key, fiat })
        })
        // No estimate is a fine answer: the XRP is shown either way.
        .catch(() => undefined)
    }, PAUSE_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [key, slug])

  return answer.key === key ? answer.fiat : {}
}
