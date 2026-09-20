/* ==========================================================================
   POST /api/verify — prove an email address.

   The second step of registration, and the gate on everything after it: until
   this succeeds the account exists but cannot open a session, so it cannot
   reach the workspace, reserve an order or see a payment address.

   Three things arrive here, and all three are one table lookup in
   netlify/lib/auth-codes.mts:

     { email, code }     the six digits from the message, typed on the page
     { token }           the link in the same message, read out of the URL
                         fragment by js/welcome.js
     { email, resend }   "send it again"

   The code and the link are the same challenge, issued together and spent
   together. Whichever arrives first consumes the row, which is why opening
   the link after typing the digits reports "already used" rather than
   failing in some way that reads as a bug.

   **Redeeming this does not open a session, deliberately.** The only thing
   that can mint one is Identity, and Identity wants the password to do it —
   which this endpoint does not have and should not be storing anywhere to
   get. So a confirmed address is sent to sign-in with the address filled in,
   one field to complete. The alternative designs all end with a credential
   parked somewhere it does not belong, and the invariant that pays for this
   one is worth more than the saved click: **a session on this site implies a
   verified address**, so every guard downstream can keep reading the session
   and nothing else.

   Responds with:
     { ok: true,  verified: true, email: string, name: string, next: string }
     { ok: true,  accepted: true, sent: boolean }            (a resend)
     { ok: false, error: string, reason?: string,
       remaining?: number, retryAfter?: number, expired?: boolean }
   ========================================================================== */

import { admin, verifyRequestOrigin, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { json, readBody, requestSignals } from '../lib/http.mjs'
import { sendVerificationEmail, sendWelcomeEmail } from '../lib/account-mail.mjs'
import {
  CODE_LENGTH,
  findAccount,
  issueCode,
  looksLikeEmail,
  markAccountVerified,
  normalizeEmail,
  redeemCode,
  redeemToken,
  type AccountRow,
  type RedeemFailure,
  type RedeemResult
} from '../lib/auth-codes.mjs'

function bad(
  error: string,
  status: number,
  extra?: Record<string, unknown>
) {
  return json({ ok: false, error, ...(extra || {}) }, status)
}

/* One message per failure, written for somebody who is looking at the form
   rather than at this file.

   'none' and 'expired' both end with "ask for another one", because from the
   page's side they are the same situation: there is nothing live to redeem.
   They are still separate here because the reasons differ and the copy that
   is accurate for one is confusing for the other — a customer who has just
   been sent a code does not want to read that it expired. */
const SAYS: Record<RedeemFailure, string> = {
  none: 'That code is not the current one for this address. Use the newest email, or send a fresh code below.',
  expired: 'That code has expired. Send a fresh one below — it only takes a moment.',
  used: 'That code has already been used. If the address is confirmed you can sign in; if not, send a fresh one below.',
  locked: 'Too many incorrect attempts on that code. Send a fresh one below and it will work again.',
  mismatch: 'That code does not match. Check the digits in the email and try again.'
}

/* A failure the page should treat by going back for another code rather than
   by letting the visitor retype. Only 'mismatch' is worth a second attempt. */
function isSpent(reason: RedeemFailure) {
  return reason !== 'mismatch'
}

/* ---------- Completing a verification ------------------------------------ */

/* Runs once a challenge has been redeemed. Order matters: the column is
   written first, because that is the gate and everything after it is a
   courtesy that must not be able to hold it up.

   markAccountVerified only reports true on the transition off NULL, which is
   what keeps the welcome email to exactly one per account however many times
   this path runs — a second tab, a link opened after the code was typed, a
   reset on an address that was already confirmed. */
async function complete(email: string, account: AccountRow | null) {
  const firstTime = await markAccountVerified(email)

  /* Belt and braces on the Identity side. admin.createUser already marks new
     users confirmed, so this is a no-op for anything registered through
     /api/register; it matters for an account created some other way, and it
     costs one call on a path that runs once per customer. Never allowed to
     fail the verification — the site's own column is the gate, not this. */
  if (account?.identity_user_id) {
    try {
      await admin.updateUser(account.identity_user_id, { confirm: true })
    } catch {
      /* Logged by the platform; nothing here depends on it. */
    }
  }

  if (firstTime) {
    await sendWelcomeEmail({
      to: email,
      name: account?.full_name || '',
      plan: account?.signup_plan || null,
      months: account?.signup_months || null,
      confirmed: true
    })
  }

  return firstTime
}

function done(email: string, account: AccountRow | null, firstTime: boolean) {
  const query = new URLSearchParams({ reason: 'verified', next: 'dashboard', email })
  if (account?.signup_plan) query.set('plan', account.signup_plan)
  if (account?.signup_months) query.set('months', account.signup_months)

  return json({
    ok: true,
    verified: true,
    firstTime,
    email,
    name: account?.full_name || '',
    plan: account?.signup_plan || '',
    months: account?.signup_months || '',
    next: `/signin.html?${query.toString()}`
  })
}

/* ---------- Handler ------------------------------------------------------- */

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return bad('Use POST to confirm an address.', 405)
  }

  /* No session is involved, but this endpoint both sends mail and consumes a
     credential, so it gets the same origin check as the other mutations. */
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

  const email = normalizeEmail(body.email)
  const code = String(body.code || '').replace(/\D+/g, '')
  const token = String(body.token || '').trim()
  const wantsResend = /^(true|1|yes)$/i.test(String(body.resend || ''))

  try {
    /* ---------- Send it again ------------------------------------------- */

    if (wantsResend) {
      if (!email || !looksLikeEmail(email)) {
        return bad('Enter the email address on the account.', 422, { field: 'email' })
      }

      const issued = await issueCode(email, 'signup', requestSignals(req, context).ip)

      if (!issued.ok) {
        return bad(
          issued.reason === 'cooldown'
            ? `A code went out moments ago. You can ask for another in ${issued.retryAfter} seconds.`
            : 'That address has asked for a lot of codes in the last hour. Give it fifteen minutes, or email Cloakshield.pro@outlook.com and we will confirm it by hand.',
          429,
          { reason: issued.reason, retryAfter: issued.retryAfter }
        )
      }

      /* Whether the address is on the account list is not in this response.
         The resend button sits on a page anyone can open, and a version of it
         that answers "no such account" is an address oracle for a customer
         list of people running paid traffic. So a live account gets a code, an
         unknown one gets nothing, and both read the same sentence.

         An address that has already confirmed also gets nothing: there is
         nothing left to confirm, and mailing a code for a completed step is
         how a customer ends up typing it into a form that cannot accept it. */
      const account = await findAccount(email)
      let sent = false

      if (account && !account.email_verified_at) {
        sent = await sendVerificationEmail({
          to: email,
          name: account.full_name,
          code: issued.code,
          token: issued.token,
          minutes: issued.minutes,
          plan: account.signup_plan,
          months: account.signup_months
        })
      }

      return json({
        ok: true,
        accepted: true,
        sent,
        minutes: issued.minutes,
        cooldown: true
      })
    }

    /* ---------- Redeem --------------------------------------------------- */

    let result: RedeemResult

    if (token) {
      result = await redeemToken('signup', token)
    } else {
      if (!email || !looksLikeEmail(email)) {
        return bad('Enter the email address on the account.', 422, { field: 'email' })
      }
      if (code.length !== CODE_LENGTH) {
        return bad(`Enter the ${CODE_LENGTH} digits from the email.`, 422, {
          field: 'code',
          reason: 'mismatch'
        })
      }
      result = await redeemCode(email, 'signup', code)
    }

    if (!result.ok) {
      return bad(SAYS[result.reason], result.reason === 'mismatch' ? 422 : 410, {
        reason: result.reason,
        expired: isSpent(result.reason),
        ...(typeof result.remaining === 'number' ? { remaining: result.remaining } : {}),
        /* A link that has been spent is very often a code that was typed
           first, on this same page, seconds earlier. Saying so is the
           difference between "something broke" and "you are already done". */
        ...(token ? { viaLink: true } : {})
      })
    }

    const firstTime = await complete(result.email, result.account)
    return done(result.email, result.account, firstTime)
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      return bad(
        'Accounts are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will confirm yours by hand.',
        503,
        { reason: 'unavailable' }
      )
    }

    if (error instanceof AuthError) {
      return bad(
        'We could not reach the identity service. Try again in a minute, or email Cloakshield.pro@outlook.com.',
        502,
        { reason: 'identity' }
      )
    }

    return bad('Something went wrong confirming that address. Please try again.', 500)
  }
}
