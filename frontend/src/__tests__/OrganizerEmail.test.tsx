/**
 * Email on an organizer application, from the applicant's side and the link's.
 *
 * Rendered inside <StrictMode> on purpose: the confirmation link carries a single-use
 * token, and StrictMode's double-run of effects is exactly what would spend it twice and
 * report "invalid" to someone who did everything right.
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OrganizerPanel } from '@/components/OrganizerPanel'
import { EmailVerifyNotice } from '@/components/EmailVerifyNotice'

type Application = {
  state: 'pending' | 'rejected'
  orgName: string
  submittedAt: string
  reviewNote: string | null
  email?: string | null
  emailVerified?: boolean
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mockApi(opts: { application?: Application | null; resend?: Response; role?: string } = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      if (url.endsWith('/policy')) return json({ platformBps: 250, maxRoyaltyBps: 2000 })
      if (url.endsWith('/organizers/me'))
        return json({ role: opts.role ?? 'USER', application: opts.application ?? null })
      if (url.endsWith('/organizers/apply')) return json({ state: 'pending', emailVerified: false, emailSent: true }, 201)
      if (url.endsWith('/organizers/email/resend')) return opts.resend ?? json({ emailSent: true })
      if (url.endsWith('/organizers/email/verify')) return json({ verified: true })
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
  return calls
}

const pending = (over: Partial<Application> = {}): Application => ({
  state: 'pending',
  orgName: 'Late Set Collective',
  submittedAt: new Date().toISOString(),
  reviewNote: null,
  email: 'host@example.com',
  emailVerified: false,
  ...over,
})

const renderPanel = (props: Partial<React.ComponentProps<typeof OrganizerPanel>> = {}) =>
  render(
    <StrictMode>
      <OrganizerPanel role="USER" onChanged={vi.fn()} {...props} />
    </StrictMode>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('the application form', () => {
  it('asks for an email, and keeps the other contact optional', async () => {
    mockApi()
    renderPanel()
    const email = (await screen.findByLabelText('email')) as HTMLInputElement
    expect(email.type).toBe('email')
    expect(screen.getByLabelText('other contact')).toBeTruthy()
    // Name and pitch alone are not enough; the email is how the decision reaches them.
    fireEvent.change(screen.getByLabelText('organisation name'), { target: { value: 'Late Set' } })
    fireEvent.change(screen.getByLabelText('what you run'), { target: { value: 'weekly league nights' } })
    expect((screen.getByRole('button', { name: /apply to organize/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(email, { target: { value: 'host@example.com' } })
    expect((screen.getByRole('button', { name: /apply to organize/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('sends the email, and omits the optional contact when it is blank', async () => {
    const calls = mockApi()
    renderPanel()
    fireEvent.change(await screen.findByLabelText('organisation name'), { target: { value: 'Late Set' } })
    fireEvent.change(screen.getByLabelText('email'), { target: { value: 'host@example.com' } })
    fireEvent.change(screen.getByLabelText('what you run'), { target: { value: 'weekly league nights' } })
    fireEvent.click(screen.getByRole('button', { name: /apply to organize/i }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/organizers/apply'))).toBe(true))
    const sent = calls.find((c) => c.url.endsWith('/organizers/apply'))!.body as Record<string, unknown>
    expect(sent).toMatchObject({ orgName: 'Late Set', email: 'host@example.com', pitch: 'weekly league nights' })
    expect(sent.contact).toBeUndefined()
  })
})

describe('waiting for review', () => {
  it('says which address the link went to and offers to send it again, while unconfirmed', async () => {
    mockApi({ application: pending() })
    renderPanel()
    expect(await screen.findByText('host@example.com')).toBeTruthy()
    expect(screen.getByText(/we only send the decision to a confirmed address/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /send the link again/i })).toBeTruthy()
  })

  it('shows a confirmed badge with a green check, and no resend, once it is', async () => {
    mockApi({ application: pending({ emailVerified: true }) })
    const { container } = renderPanel()
    const badge = (await screen.findByText('Email confirmed')).closest('[data-slot="badge"]') as HTMLElement
    expect(badge).not.toBeNull()
    // The check carries the colour; the words carry the meaning and stay foreground.
    expect(badge.querySelector('svg')?.getAttribute('class')).toMatch(/text-live/)
    expect(badge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    // The badge sits beside "under review", and the sentence no longer repeats it.
    expect(screen.getByText('under review')).toBeTruthy()
    expect(container.textContent!.match(/email confirmed/gi)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /send the link again/i })).toBeNull()
  })

  it('shows no confirmed badge while the address is unconfirmed', async () => {
    mockApi({ application: pending({ emailVerified: false }) })
    renderPanel()
    await screen.findByRole('button', { name: /send the link again/i })
    expect(screen.queryByText('Email confirmed')).toBeNull()
  })

  it('shows no confirmed badge for an application with no email at all', async () => {
    // A confirmation of nothing would be a lie.
    mockApi({ application: pending({ email: null, emailVerified: true }) })
    renderPanel()
    await screen.findByText(/is with the hubworld team/i)
    expect(screen.queryByText('Email confirmed')).toBeNull()
  })

  it('shows the server\'s wait when a resend is too soon, instead of failing silently', async () => {
    mockApi({
      application: pending(),
      resend: json({ error: 'Wait 42s before asking for another email' }, 429),
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /send the link again/i }))
    expect(await screen.findByText(/wait 42s/i)).toBeTruthy()
  })

  it('does not claim an email was sent when the server says it could not send one', async () => {
    mockApi({ application: pending(), resend: json({ emailSent: false }) })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /send the link again/i }))
    expect(await screen.findByText(/could not send it just now/i)).toBeTruthy()
    expect(screen.queryByText(/check your inbox/i)).toBeNull()
  })

  it('copes with an application from before email existed', async () => {
    mockApi({ application: pending({ email: null, emailVerified: false }) })
    renderPanel()
    expect(await screen.findByText(/is with the hubworld team/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send the link again/i })).toBeNull()
  })
})

describe('the emailed link', () => {

  it('spends the token exactly once even when StrictMode runs the effect twice', async () => {
    const calls = mockApi()
    window.history.replaceState(null, '', '/organize?verify=tok_once_aaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const onVerified = vi.fn()
    render(
      <StrictMode>
        <EmailVerifyNotice onVerified={onVerified} />
      </StrictMode>,
    )
    expect(await screen.findByText(/email confirmed/i)).toBeTruthy()
    // The bug this pins: a second request for a single-use token reads as "invalid".
    expect(calls.filter((c) => c.url.endsWith('/organizers/email/verify'))).toHaveLength(1)
    expect(screen.queryByText(/invalid or has expired/i)).toBeNull()
    expect(onVerified).toHaveBeenCalled()
  })

  it('removes the token from the address bar once it has been read', async () => {
    mockApi()
    window.history.replaceState(null, '', '/organize?verify=tok_clean_bbbbbbbbbbbbbbbbbbbbbbbbbbbb&x=1')
    render(<EmailVerifyNotice />)
    await screen.findByText(/email confirmed/i)
    expect(window.location.search).toBe('?x=1')
    expect(window.location.href).not.toContain('tok_clean')
  })

  it('says plainly what to do when the link is bad, and does not report success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'This link is invalid or has expired' }, 400)),
    )
    window.history.replaceState(null, '', '/organize?verify=tok_bad_cccccccccccccccccccccccccccc')
    const onVerified = vi.fn()
    render(<EmailVerifyNotice onVerified={onVerified} />)
    expect(await screen.findByText(/invalid or has expired/i)).toBeTruthy()
    expect(screen.getByText(/ask for a new one/i)).toBeTruthy()
    expect(onVerified).not.toHaveBeenCalled()
  })

  it('renders nothing at all, and makes no request, when there is no link', () => {
    const calls = mockApi()
    const { container } = render(<EmailVerifyNotice />)
    expect(container.textContent).toBe('')
    expect(calls).toHaveLength(0)
  })
})
