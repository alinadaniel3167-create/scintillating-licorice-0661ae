/* ==========================================================================
   POST /api/reset — redeem a reset challenge and set a new password.

   The other half of /api/recover. The message that function sends carries
   both halves of one challenge, so this endpoint takes either:

     { token, password, confirm }         the link, read out of the URL
                                          fragment by js/reset.js
     { email, code, password, confirm }   the six digits, typed on the page

   Whichever arrives first consumes the row. A customer who types the code and
   then opens the link is told the challenge is already spent, which is
   correct and is also why that message says to sign in rather than to try
   again.

   **The token is this site's own, not Identity's.** It used to be
   recoverPassword(), which redeemed a GoTrue-minted token, wrote the password
   and opened the session in one call. That token only ever existed inside
   GoTrue and could only be mailed by whatever SMTP server the Identity
   settings named — empty on a new project, and silently so. See the header of
   /api/recover for why that failure mode is the one this design is built
   against.

   So the sequence here is four steps rather than one, and the order is the
   part to preserve:

     1. redeem the challenge          (single-use, enforced by the database)
     2. write the password            (admin.updateUser, server-side only)
     3. mark the address verified     (see below)
     4. open a session                (login, with the password just written)

   A failure at 1 or 2 leaves the account exactly as it was. A failure at 3
   or 4 leaves the new password in place and no session, which lands the
   visitor on sign-in with a password that works — an inconvenience, not a
   lockout. There is no ordering that avoids a window entirely without a
   transaction spanning two services, and this is the window that fails
   safely.

   **Step 3 is not housekeeping.** Redeeming a code sent to an address proves
   control of that inbox just as thoroughly as the signup code does, so a
   reset confirms the address. Without it, somebody who registered, never
   confirmed, and reset the password they had forgotten would hold an account
   that can never open a session — and /api/login is the thing that reads
   that column.

   Because a session comes back with this, the page that calls it navigates
   with a full page load afterwards, exactly as sign-in does: the cookies are
   set on the response to this request and have to travel with the next one.

   A completed reset also mails the account a notice that the password
   changed, with the time and the rough origin of the request. That one is
   not optional the way the sign-in notice is: the reader it exists for is
   somebody whose password was just changed by someone else, and the reset
   link they need is only useful if they hear about it. It cannot fail the
   reset — the password is already written by the time it is attempted.

   Responds with:
     { ok: true,  email: string, name: string, next: string }
     { ok: false, error: string, field?: Field, expired?: boolean }
   ========================================================================== */

import { admin, login, verifyRequestOrigin, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { json, readBody, requestSignals } from '../lib/http.mjs'
import { sendPasswordChangedEmail } from '../lib/account-mail.mjs'
import {
  CODE_LENGTH,
  looksLikeEmail,
  markAccountVerified,
  normalizeEmail,
  redeemCode,
  redeemToken,
  upsertAccount,
  type AccountRow,
  type RedeemFailure,
  type RedeemResult
} from '../lib/auth-codes.mjs'

/* Matched to the register function. A reset that accepted a weaker password
   than registration would be a way around the rule rather than an exception
   to it. */
const MIN_PASSWORD = 8

type Field = 'password' | 'confirm' | 'code' | 'email'

function bad(error: string, status: number, extra?: Record<string, unknown>) {
  return json({ ok: false, error, ...(extra || {}) }, status)
}

function badField(error: string, status: number, field: Field) {
  return bad(error, status, { field })
}

/* Every one of these ends the same way — ask for another link — because from
   the page's side they are one situation: there is nothing live to redeem.
   They stay separate because the sentence that is accurate for an expired
   code is confusing for a spent one, and a customer who has just finished
   resetting their password should be told to sign in, not to start over. */
const SAYS: Record<RedeemFailure, string> = {
  none: 'That reset code is not the current one for this address. Use the newest email, or ask for a fresh link below.',
  expired: 'That reset link has expired. Ask for a fresh one below — it only takes a moment.',
  used: 'That reset link has already been used. If the password was changed you can sign in with it; otherwise ask for a fresh link below.',
  locked: 'Too many incorrect attempts on that code. Ask for a fresh link below and it will work again.',
  mismatch: 'That code does not match. Check the digits in the email and try again.'
}

/* ==========================================================================
   Which Identity user to write the password to.

   Normally the accounts row holds the id, put there by /api/register. The
   fallback exists for a row that predates this table — the migration
   backfilled addresses out of `orders`, and an order only carries an
   identity_user_id if one was recorded on it.

   admin.listUsers pages and does not filter, so this is a scan, and it is
   capped rather than unbounded: a reset that walks an entire user list on
   every attempt is a denial of service with a valid credential in front of
   it. The id is written back to the accounts row when it is found, so the
   scan happens at most once per legacy account.
   ========================================================================== */
const SCAN_PAGES = 10
const SCAN_PER_PAGE = 100

async function resolveIdentityUserId(email: string, account: AccountRow | null) {
  if (account?.identity_user_id) return account.identity_user_id

  for (let page = 1; page <= SCAN_PAGES; page += 1) {
    const users = await admin.listUsers({ page, perPage: SCAN_PER_PAGE })
    if (!users || users.length === 0) return null

    const match = users.find((user) => normalizeEmail(user.email) === email)
    if (match?.id) {
      /* Cheap, and it means the next reset on this account is one lookup. */
      try {
        await upsertAccount({ email, identityUserId: match.id })
      } catch {
        /* The password write below is what matters; this was an optimisation. */
      }
      return match.id
    }

    if (users.length < SCAN_PER_PAGE) return null
  }

  return null
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return bad('Use POST to set a new password.', 405)
  }

  /* Sets cookies, so it checks its own origin like the other mutations. */
  try {
    verifyRequestOrigin(req)
  } catch {
    return bad('That request did not come from this site.', 403)
  }

  let body: Record<string, string>
  try {
    body = await readBody(req)
  } catch {
    return bad('That request could not be read.', 400)
  }

  const token = String(body.token || '').trim()
  const email = normalizeEmail(body.email)
  const code = String(body.code || '').replace(/\D+/g, '')
  const password = String(body.password || '')
  const confirm = String(body.confirm || '')

  /* The password rules run before the challenge is redeemed, on purpose. A
     code is single-use, so spending one on a request that was going to be
     refused for a short password would cost the customer the whole round
     trip through their inbox. */
  if (!password) return badField('Choose a new password.', 422, 'password')
  if (password.length < MIN_PASSWORD) {
    return badField(`Use at least ${MIN_PASSWORD} characters.`, 422, 'password')
  }
  /* Checked in the browser too. Repeated here because the browser copy is a
     convenience and this one is the rule — a mistyped password nobody can
     reproduce is a second reset request at best. */
  if (confirm !== password) {
    return badField('Both passwords need to match.', 422, 'confirm')
  }

  if (!token) {
    if (!email || !looksLikeEmail(email)) {
      return badField('Enter the email address on the account.', 422, 'email')
    }
    if (code.length !== CODE_LENGTH) {
      return badField(`Enter the ${CODE_LENGTH} digits from the email.`, 422, 'code')
    }
  }

  try {
    const result: RedeemResult = token
      ? await redeemToken('recovery', token)
      : await redeemCode(email, 'recovery', code)

    if (!result.ok) {
      return bad(SAYS[result.reason], result.reason === 'mismatch' ? 422 : 410, {
        reason: result.reason,
        /* js/reset.js shows the "ask for another" step on `expired`, and
           leaves the visitor on the password form to retype on a mismatch. */
        expired: result.reason !== 'mismatch',
        ...(result.reason === 'mismatch' ? { field: 'code' as Field } : {}),
        ...(typeof result.remaining === 'number' ? { remaining: result.remaining } : {})
      })
    }

    const userId = await resolveIdentityUserId(result.email, result.account)

    if (!userId) {
      /* The challenge was valid and has been spent, but there is no Identity
         user to write to — an accounts row with no counterpart, which only a
         hand-edited row or a half-finished registration produces. Nothing
         useful can be said about it to the visitor beyond who to ask. */
      return bad(
        'That address does not have a password to reset. Email Cloakshield.pro@outlook.com and we will sort it out.',
        409,
        { reason: 'no_identity_user' }
      )
    }

    /* One call writes the password and confirms the address on the Identity
       side. `confirm: true` is a no-op for anything registered through
       /api/register — admin.createUser already set it — and matters for a
       legacy user who never redeemed Identity's own confirmation link. */
    await admin.updateUser(userId, { password, confirm: true })

    /* The gate. See the header: redeeming a code mailed to this address
       proves the inbox, so the reset confirms it. */
    await markAccountVerified(result.email)

    const signals = requestSignals(req, context)

    /* Best-effort, and the one step above that is allowed to fail without
       the response changing much: the password is written either way, so a
       failure here means signing in by hand rather than landing signed in. */
    let signedIn = false
    try {
      await login(result.email, password)
      signedIn = true
    } catch {
      signedIn = false
    }

    await sendPasswordChangedEmail({
      to: result.email,
      name: result.account?.full_name || '',
      at: Date.now(),
      ip: signals.ip,
      location: signals.location
    })

    return json({
      ok: true,
      email: result.email,
      name: result.account?.full_name || '',
      signedIn,
      next: signedIn
        ? '/dashboard.html'
        : `/signin.html?reason=reset&email=${encodeURIComponent(result.email)}`
    })
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      return bad(
        'Password resets are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will reset yours by hand.',
        503,
        { reason: 'unavailable' }
      )
    }

    if (error instanceof AuthError) {
      /* 422 with a password in the message is Identity's own policy talking.
         The length and match rules above have already run, so anything left
         is a rule this file does not know about and Identity's wording is
         more use to the visitor than ours would be. */
      if (error.status === 422 && /password/i.test(error.message || '')) {
        return badField(error.message, 422, 'password')
      }

      return bad(
        'We could not reach the identity service to set that password. Try again in a minute, or email Cloakshield.pro@outlook.com.',
        502,
        { reason: 'identity' }
      )
    }

    return bad('Something went wrong setting that password. Please try again.', 500)
  }
}
