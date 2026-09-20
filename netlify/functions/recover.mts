/* ==========================================================================
   POST /api/recover — ask for a password reset.

   The counterpart to /api/register: registration is the only way an address
   gets onto the account list, and this is the only way back in when the
   password that went with it is gone.

   **The reset message is this site's own now.** It used to be Identity's:
   requestPasswordRecovery() asks GoTrue to mint a token and mail
   /email-templates/recovery.html through whatever SMTP server the Identity
   settings point at. The token never leaves GoTrue, so no code here could
   put it in a Resend message — and an empty Identity mail setting, which is
   how every new project starts, produces a reset that reports success and
   sends nothing at all. A customer sitting on "check your inbox" has no way
   to tell that from a slow mail server.

   So the challenge is issued here, by netlify/lib/auth-codes.mts, and mailed
   over the same Resend transport as every other message this site sends. It
   carries a single-use link and the same six digits, so the message works
   whether the customer clicks or types — see /api/reset for the other half.

   Two things this function deliberately will not do.

   It will not say whether the address is on the account list. A reset form
   that answers "no such account" is an address oracle, and the addresses on
   this particular list are people running paid traffic. Every readable
   outcome — sent, unknown address, already asked twice this minute — comes
   back the same way, so the response below is neutral by construction rather
   than by remembering to be careful in each branch.

   And it will not claim an email is on its way when one cannot be. With no
   Resend key and no verified sender there is no mailer, no message and no
   link, and the honest answer is a 503 that names the support address. The
   screen that says "a reset link is on its way" over a link that could never
   arrive is worse than an error: the customer waits, checks spam, waits
   again, and only then writes in.

   Responds with:
     { ok: true,  accepted: true }
     { ok: false, error: string, field?: 'email', code?: string }
   ========================================================================== */

import { verifyRequestOrigin } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { fail, json, readBody, requestSignals } from '../lib/http.mjs'
import { mailerReady } from '../lib/mail.mjs'
import { sendPasswordResetEmail } from '../lib/account-mail.mjs'
import { findAccount, issueCode, looksLikeEmail, normalizeEmail } from '../lib/auth-codes.mjs'

/* The one success response, used for every outcome that is not a failure of
   this site. Whether the address was on the list is not in it. */
function accepted() {
  return json({ ok: true, accepted: true })
}

/* The shared fail() takes a machine-readable code as its third argument, not a
   field name, and the form keys its inline errors off `field`. So the one
   field this endpoint has gets its own helper rather than borrowing that slot
   and landing the message next to no input at all. */
function failField(error: string, status: number) {
  return json({ ok: false, error, field: 'email' }, status)
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to request a reset link.', 405)
  }

  /* This endpoint sends mail on the strength of a request body alone, so it
     gets the same origin check as the other mutations. Without it another
     site could quietly have reset mail sent to addresses it is guessing at. */
  try {
    verifyRequestOrigin(req)
  } catch {
    return fail('That request did not come from this site.', 403)
  }

  let body: Record<string, string>
  try {
    body = await readBody(req)
  } catch {
    return fail('That request could not be read.', 400)
  }

  const email = normalizeEmail(body.email)

  if (!email) return failField('Enter the email address on the account.', 422)
  if (!looksLikeEmail(email)) {
    return failField('That email address does not look right.', 422)
  }

  /* Checked before anything is written, because the neutral response above is
     only honest while a message can actually leave. mailerReady() reads the
     key and the sender rather than trying a send, so this is the
     "not configured at all" case — a key that exists but has lapsed still
     reports ready here and fails on the send, which is why the send's own
     result is logged and /api/health has a probe. */
  if (!mailerReady()) {
    return fail(
      'Password resets are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will reset yours by hand.',
      503,
      'unavailable'
    )
  }

  try {
    const signals = requestSignals(req, context)

    /* Issued before the account is looked up, and the throttle answers the
       same way for an address that exists and one that does not — otherwise
       the *timing* and the retry ceiling become the oracle that the response
       body was carefully written not to be. A refusal here is reported as
       accepted for the same reason: a code from thirty seconds ago is still
       live, so "the link is on its way" remains true. */
    const issued = await issueCode(email, 'recovery', signals.ip)
    if (!issued.ok) return accepted()

    const account = await findAccount(email)

    if (account) {
      await sendPasswordResetEmail({
        to: email,
        name: account.full_name,
        code: issued.code,
        token: issued.token,
        minutes: issued.minutes,
        ip: signals.ip,
        location: signals.location
      })
    }

    /* An address with no account gets no message. Not an error: there is
       nothing to reset, and inventing a "someone asked to reset a password
       you do not have" mail turns this endpoint into a way to send strangers
       email from a verified domain. */
    return accepted()
  } catch {
    return fail('Something went wrong sending that link. Please try again.', 500)
  }
}
