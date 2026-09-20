/* ==========================================================================
   POST /api/confirm — redeem an email confirmation token.

   Netlify Identity mails a link back to the site with the token in the URL
   fragment. The welcome page reads it and posts it here; this is the only
   place the token is redeemed, because doing it in the browser would mean
   bundling the Identity client into a site that has no build step.

   **This is now the legacy path, and it is kept for one reason: the links
   already sitting in inboxes.** New registrations do not come through here at
   all — /api/register creates the account through the Identity admin API,
   which mails nothing, and the site sends its own six-digit code and link for
   /api/verify to redeem. See the header of register.mts for why.

   So nothing needs to be added to this function. It needs to keep working
   until every Identity-minted confirmation link has expired, and then it can
   go. What it does do, beyond redeeming the token, is write the same
   `accounts` row the new path writes: that column is what /api/login reads,
   and a customer who confirms through an old link must end up with an account
   that can open a session just like one who types a code.

   Redeeming the token is also what triggers the welcome email, because this
   is the moment the account becomes usable. The token is single-use, and the
   welcome send is behind markAccountVerified()'s transition check as well, so
   neither a second POST nor a code redeemed in another tab can produce a
   duplicate.

   Responds with JSON the welcome page can act on:
     { ok: true,  email: string }
     { ok: false, error: string, expired?: boolean }
   ========================================================================== */

import { confirmEmail, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { sendWelcomeEmail } from '../lib/account-mail.mjs'
import { markAccountVerified, normalizeEmail, upsertAccount } from '../lib/auth-codes.mjs'

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  })
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Use POST to confirm an address.' }, 405)
  }

  let token = ''

  try {
    const body = (await req.json()) as Record<string, unknown>
    token = String(body.token ?? '').trim()
  } catch {
    return json({ ok: false, error: 'That request could not be read.' }, 400)
  }

  if (!token) {
    return json({ ok: false, error: 'This link is missing its confirmation token.' }, 422)
  }

  try {
    const user = await confirmEmail(token)

    /* The plan the visitor picked before registering, carried through signup
       as user metadata so the email can name it and link straight at it. */
    const meta = (user?.userMetadata || {}) as Record<string, unknown>
    const email = normalizeEmail(user?.email)
    const plan = meta.signup_plan ? String(meta.signup_plan) : null
    const months = meta.signup_months ? String(meta.signup_months) : null

    /* The row, then the gate. Both are needed for the account to be able to
       sign in — see the note at the top. Wrapped because the token is already
       spent by this point: failing the response now would leave the customer
       with a confirmed address and a screen telling them it did not work. */
    let firstTime = true
    if (email) {
      try {
        await upsertAccount({
          email,
          identityUserId: user?.id ?? null,
          fullName: user?.name ?? null,
          signupPlan: plan,
          signupMonths: months
        })
        firstTime = await markAccountVerified(email)
      } catch {
        firstTime = true
      }
    }

    if (firstTime) {
      await sendWelcomeEmail({
        to: email,
        name: user?.name ?? '',
        plan,
        months,
        confirmed: true
      })
    }

    return json({ ok: true, email })
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      return json(
        {
          ok: false,
          error: 'Accounts are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will confirm yours by hand.'
        },
        503
      )
    }

    if (error instanceof AuthError) {
      /* A token that has already been redeemed and one that has expired both
         come back in the 401/404/422 band, and the fix is the same either
         way: send another confirmation email. */
      return json(
        {
          ok: false,
          expired: true,
          error: 'This confirmation link has expired or has already been used. Request a new one below.'
        },
        error.status && error.status >= 400 && error.status < 500 ? error.status : 502
      )
    }

    return json({ ok: false, error: 'Something went wrong confirming the address. Please try again.' }, 500)
  }
}
