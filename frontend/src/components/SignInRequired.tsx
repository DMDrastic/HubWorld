/**
 * What a signed-out visitor gets on a page that genuinely needs an account.
 *
 * Before this, every route rendered `Landing` when signed out, so `/tickets`
 * showed the marketing page while the address bar still said `/tickets`. The URL
 * and the content disagreed, which breaks the back button's meaning and makes a
 * shared link land somewhere other than where it pointed.
 *
 * So the page keeps its own heading and says plainly why it is empty. The
 * distinction being drawn: `/events` is public because it is about the world,
 * while these pages are about *you* — what you hold, what you are selling, what
 * you may admit — and there is no honest way to render them for nobody.
 */
import { PageHeader } from '@/components/PageHeader'
import { EmailSignIn } from '@/components/EmailSignIn'
import { SignIn } from '@/components/SignIn'
import type { AuthUser } from '@/lib/api'

export function SignInRequired({
  title,
  blurb,
  onAuthenticated,
}: {
  title: string
  /** Why an account is needed here specifically, not a generic "please log in". */
  blurb: string
  onAuthenticated: (u: AuthUser) => void
}) {
  return (
    <section className="space-y-2 pb-8">
      <PageHeader title={title} description={blurb} />

      <div className="max-w-sm space-y-4">
        <SignIn onAuthenticated={onAuthenticated} />
        {/* Draws nothing unless the deployment has the email wallet switched on and its code has loaded. */}
        <EmailSignIn onAuthenticated={onAuthenticated} />
      </div>
    </section>
  )
}
