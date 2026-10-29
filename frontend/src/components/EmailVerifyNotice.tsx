/**
 * What happens when someone opens the link in their confirmation email.
 *
 * The link is `/organize?verify=<token>`. Opening it changes nothing by itself: this
 * component reads the token and POSTs it, because a GET that verifies would be fired by
 * every mail scanner and link previewer that fetches URLs in a message, spending a
 * single-use token before the person ever sees it.
 *
 * Two traps are handled on purpose:
 * - StrictMode runs effects twice in development. A single-use token spent by the first
 *   run would make the second report "invalid", so concurrent uses of one token share one
 *   request (`inflight`).
 * - The token is removed from the address bar once read, so it is not left in browser
 *   history, a shared screenshot or a copied URL.
 *
 * It renders for signed-out visitors too: people open the email on whatever device holds
 * it, and the token alone is the proof.
 */
import { useEffect, useState } from 'react'
import { verifyOrganizerEmail } from '@/lib/api'

const inflight = new Map<string, Promise<boolean>>()

function spend(token: string): Promise<boolean> {
  let p = inflight.get(token)
  if (!p) {
    p = verifyOrganizerEmail(token).then(
      (r) => r.verified,
      () => false,
    )
    inflight.set(token, p)
  }
  return p
}

type State = 'idle' | 'checking' | 'verified' | 'invalid'

export function EmailVerifyNotice({ onVerified }: { onVerified?: () => void }) {
  // Read ONCE, at first render, and held in state. The effect below removes the token
  // from the address bar, and StrictMode runs that effect twice: if the second run read
  // the URL again it would find nothing, and the first run's result is discarded when its
  // cleanup fires, so the notice would sit on "Confirming…" forever.
  const [token] = useState(() => new URLSearchParams(window.location.search).get('verify'))
  const [state, setState] = useState<State>(token ? 'checking' : 'idle')

  useEffect(() => {
    if (!token) return
    let live = true
    void spend(token).then((ok) => {
      if (!live) return
      setState(ok ? 'verified' : 'invalid')
      if (ok) onVerified?.()
    })
    // Idempotent: the second StrictMode run finds it already gone and changes nothing.
    const params = new URLSearchParams(window.location.search)
    if (params.has('verify')) {
      params.delete('verify')
      const rest = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''))
    }
    return () => {
      live = false
    }
    // Spending the token once is the point; the callback is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  if (state === 'idle') return null

  const copy = {
    checking: 'Confirming your email…',
    verified: 'Email confirmed. We can now send you the decision on your application.',
    invalid:
      'That link is invalid or has expired. Sign in, open Organize, and ask for a new one.',
  }[state]

  return (
    <p
      role="status"
      className={`mt-4 rounded-xl border p-3.5 text-sm ${
        state === 'invalid' ? 'border-destructive/40 text-destructive' : 'surface'
      }`}
    >
      {copy}
    </p>
  )
}
