/* ==========================================================================
   POST /api/login — sign in to an existing account.

   Registration has always been server-side on this site; signing in was not,
   because until now nothing needed a session — the browser store was the
   gate. It is not any more: /api/order, /api/claim and /api/subscription all
   ask Identity who is calling, so a customer coming back on a new device or
   after clearing their browser needs a way in.

   The session is Identity's: login() sets the nf_jwt and nf_refresh cookies
   through the Functions runtime, which is why the page that calls this does a
   full navigation afterwards rather than a client-side route change.

   **This function is where email verification is enforced**, and that is the
   one thing to understand before editing it.

   /api/register creates the account through the Identity admin API, which
   marks it confirmed on the GoTrue side immediately and sends no mail — the
   confirmation message is this site's own, and the code in it is redeemed by
   /api/verify. So GoTrue's `confirmedAt` no longer means the address was
   proved; `accounts.email_verified_at` does, and an account that has not
   redeemed its code will be handed a session by login() that this function
   then takes back.

   Taking it back is not cosmetic. **Every guard on the payment path reads the
   session and nothing else** — /api/order will reserve an amount for anyone
   Identity recognises — so the invariant those guards rest on is that a
   session implies a verified address. This is the only place that invariant
   is established, which is why the rejection branch below calls logout()
   before it responds rather than simply returning an error and leaving the
   cookies in place.

   A successful sign-in also sends a security notice to the address that was
   used, with the time, the rough location and the browser. It is awaited
   rather than fired and forgotten, because a function container can be
   frozen the moment it responds and a send that was never going to complete
   is worse than a few hundred milliseconds — but it is capped by the mailer's
   own timeout and can never turn a good sign-in into a failed one. Set
   SIGNIN_ALERT_EMAILS=off to stop sending them.

   Responds with:
     { ok: true,  email: string, name: string, next: string }
     { ok: false, error: string, field?: 'email' | 'password',
       needsVerification?: true, next?: string }
   ========================================================================== */

import { login, logout, verifyRequestOrigin, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { fail, json, readBody, requestSignals } from '../lib/http.mjs'
import { sendSignInEmail, sendVerificationEmail } from '../lib/account-mail.mjs'
import {
  findAccount,
  issueCode,
  markAccountVerified,
  normalizeEmail,
  upsertAccount
} from '../lib/auth-codes.mjs'

/* Where the form may send someone afterwards. An open redirect on a login
   endpoint is how a phishing page borrows a real domain, so the destination
   is a fixed choice rather than a URL from the request. */
const DESTINATIONS: Record<string, string> = {
  dashboard: '/dashboard.html',
  checkout: '/checkout.html',
  home: '/'
}

/* The shared fail() takes a machine-readable code as its third argument, not
   a field name, and js/signin.js keys its inline errors off `field` — so the
   two fields this form has get their own helper rather than borrowing that
   slot and landing the message next to no input at all. */
function failField(error: string, status: number, field: 'email' | 'password') {
  return json({ ok: false, error, field }, status)
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to sign in.', 405)
  }

  try {
    /* This endpoint changes state (it sets cookies) and there is no framework
       origin check in front of it, so it does its own. */
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
  const password = String(body.password || '')
  const target = String(body.next || 'dashboard').trim()

  if (!email) return failField('Enter the email address on the account.', 422, 'email')
  if (!password) return failField('Enter your password.', 422, 'password')

  try {
    const user = await login(email, password)
    const account = await findAccount(email)

    /* ---------- The gate ---------------------------------------------------
       A row that exists and has never been verified stops here. The cookies
       login() just set are dropped first, so nothing downstream can read a
       session this address is not entitled to, and then a fresh code goes
       out — somebody who is typing their password months later has long lost
       the original message, and an error with no way forward is how that
       account gets abandoned.

       No row at all means an account that predates the accounts table. Those
       are verified by construction: they were created by signup(), which
       leaves a user unconfirmed, and GoTrue refuses a session to an
       unconfirmed address — so the session in hand is the proof. The row is
       written now, verified, which closes the gap the migration's backfill
       could not see. */
    if (account && !account.email_verified_at) {
      await logout()

      const signals = requestSignals(req, context)
      const issued = await issueCode(email, 'signup', signals.ip)

      if (issued.ok) {
        await sendVerificationEmail({
          to: email,
          name: account.full_name,
          code: issued.code,
          token: issued.token,
          minutes: issued.minutes,
          plan: account.signup_plan,
          months: account.signup_months
        })
      }

      const query = new URLSearchParams({ email })
      if (account.signup_plan) query.set('plan', account.signup_plan)
      if (account.signup_months) query.set('months', account.signup_months)

      return json(
        {
          ok: false,
          error: issued.ok
            ? 'This address has not been confirmed yet. We have just sent a fresh confirmation code — enter it to finish setting up the account.'
            : 'This address has not been confirmed yet. Enter the code from the most recent confirmation email to finish setting up the account.',
          field: 'email',
          needsVerification: true,
          email,
          next: `/welcome.html?${query.toString()}`
        },
        403
      )
    }

    if (!account) {
      try {
        await upsertAccount({
          email,
          identityUserId: user?.id ?? null,
          fullName: user?.name ?? null
        })
        await markAccountVerified(email)
      } catch {
        /* The session is already open and Identity had already confirmed this
           address, so a failure to record the row changes nothing for this
           sign-in — the next one tries again. */
      }
    }

    /* Best-effort and deliberately unchecked: the session is already open, so
       whether the notice was delivered changes nothing about this response. */
    const signals = requestSignals(req, context)
    await sendSignInEmail({
      to: user?.email ?? email,
      name: user?.name ?? account?.full_name ?? '',
      at: Date.now(),
      ip: signals.ip,
      location: signals.location,
      device: signals.device
    })

    return json({
      ok: true,
      email: user?.email ?? email,
      name: user?.name ?? account?.full_name ?? '',
      next: DESTINATIONS[target] || DESTINATIONS.dashboard
    })
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      return fail(
        'Sign-in is not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will help.',
        503
      )
    }

    if (error instanceof AuthError) {
      /* GoTrue answers 400 for an unconfirmed address and 401 for bad
         credentials. An unconfirmed address reaching this branch means a user
         created by the old signup() path, so it gets the same offer as the
         gate above: the confirmation page, where a fresh code can be sent. */
      if (error.status === 400 && /confirm/i.test(error.message || '')) {
        return json(
          {
            ok: false,
            error:
              'This address has not been confirmed yet. Ask for a fresh confirmation code and enter it to finish setting up the account.',
            field: 'email',
            needsVerification: true,
            email,
            next: `/welcome.html?email=${encodeURIComponent(email)}`
          },
          403
        )
      }

      /* Deliberately vague: telling a stranger which addresses exist is a
         favour to whoever is guessing. */
      return failField('That email address and password do not match an account.', 401, 'password')
    }

    return fail('Something went wrong signing in. Please try again.', 500)
  }
}
