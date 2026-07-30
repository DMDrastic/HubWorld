/**
 * Last line of defence for a render-time exception.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, so
 * without this a single bad value anywhere — a malformed date, a null the types
 * promised could not happen — replaces the entire app with a blank white page.
 * No message, no way back, and nothing in the UI to say what went wrong.
 *
 * This deliberately does NOT try to recover automatically. The component that
 * threw will very likely throw again on the next render with the same props, so
 * a silent retry loops. It offers the two things that actually work: reload, or
 * go back to the hub.
 *
 * It has to be a class. `componentDidCatch` and `getDerivedStateFromError` have
 * no hook equivalent — this is the one place React still requires one.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only reporter here. If error tracking is ever added,
    // this is the single place it needs to hook into.
    console.error('Unhandled render error:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="bg-card ring-foreground/8 w-full max-w-md rounded-2xl p-8 ring-1">
          <h1 className="text-xl font-semibold tracking-tight">Something broke</h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            This page hit an error it could not recover from. Your tickets are held on the XRP
            Ledger, not in this app, so nothing has been lost.
          </p>

          {/* The message, not the stack. It is often the one clue that makes a
              bug report actionable, and it is already visible in the console. */}
          <pre className="bg-muted text-muted-foreground mt-4 overflow-x-auto rounded-lg p-3 font-mono text-xs">
            {error.message || String(error)}
          </pre>

          <div className="mt-6 flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="bg-primary text-primary-foreground hover:bg-primary/85 focus-visible:ring-ring rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              Reload
            </button>
            {/* A full navigation, not a router push: the router would keep this
                broken tree mounted and re-render straight back into the error. */}
            <button
              type="button"
              onClick={() => {
                window.location.href = '/'
              }}
              className="hover:bg-accent focus-visible:ring-ring rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              Back to the hub
            </button>
          </div>
        </div>
      </div>
    )
  }
}
