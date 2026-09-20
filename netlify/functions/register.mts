/* ==========================================================================
   POST /api/register — create a CloakShield Pro account.

   The public site is static, so registration is the one thing that needs a
   server. Passwords are never handled here beyond forwarding them to Netlify
   Identity, which owns hashing and session cookies. The rest of the form is
   profile metadata and rides along on the create call as user metadata.

   **The confirmation email is this site's own now**, and that is the change
   to understand before editing anything below.

   It used to be Identity's. signup() creates an unconfirmed user and asks
   GoTrue to mail the token, rendered from email-templates/confirmation.html
   and dispatched by whatever SMTP server the Identity settings point at. The
   token never leaves GoTrue, so nothing here could put it in a Resend
   message — and when the Identity mail settings are empty, which is how every
   new project starts, the result is a registration that reports success and
   sends nothing. Nobody finds out until a customer says the email never
   arrived.

   So this function creates the user through the admin API instead, which
   sends no mail at all, and the site issues its own challenge: a six-digit
   code and a matching single-use link, from netlify/lib/auth-codes.mts, both
   carried by one Resend message. `confirmationSent` in the response is the
   mailer's actual answer rather than an assumption about it.

   The admin API creates users already confirmed as far as GoTrue is
   concerned, so **the gate is `accounts.email_verified_at` and /api/login is
   what enforces it.** That is not a weaker arrangement than the old one, but
   it is a different one: an unverified account exists and has a password, and
   the thing it cannot do is open a session. Every invariant the payment path
   depends on still holds, because they all rest on the session rather than on
   GoTrue's confirmation flag — see the note in login.mts.

   Responds with JSON the register page can act on:
     { ok: true,  verified: false, confirmationSent: boolean,
       existing?: true, email: string, minutes: number }
     { ok: false, error: string, field?: Field, code?: string }
   ========================================================================== */

import { admin, verifyRequestOrigin, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { requestSignals } from '../lib/http.mjs'
import { sendVerificationEmail } from '../lib/account-mail.mjs'
import {
  findAccount,
  issueCode,
  looksLikeEmail,
  normalizeEmail,
  upsertAccount
} from '../lib/auth-codes.mjs'

const MIN_PASSWORD = 8

type Field = 'email' | 'password' | 'full_name' | 'country' | 'use_case' | 'account_type'

/* The three options the form offers, mirrored here so a hand-crafted request
   cannot write something else into the account record. */
const ACCOUNT_TYPES = ['individual', 'sole_proprietor', 'legal_entity'] as const

interface Registration {
  email: string
  password: string
  confirm: string
  fullName: string
  country: string
  useCase: string
  accountType: string
  plan: string
  months: string
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  })
}

function fail(error: string, status: number, field?: Field, code?: string) {
  const body: Record<string, unknown> = { ok: false, error }
  if (field) body.field = field
  if (code) body.code = code
  return json(body, status)
}

/* Free-text lands in the account record and in support tickets, so it is
   trimmed and capped rather than stored at whatever length arrives. */
function clamp(value: string, max: number) {
  return value.trim().slice(0, max)
}

/* Accepts both a JSON body (the register page) and a urlencoded one, so the
   endpoint still works if the form is ever submitted without JavaScript. */
async function readRegistration(req: Request): Promise<Registration> {
  const type = req.headers.get('content-type') || ''
  let get: (key: string) => string

  if (type.includes('application/json')) {
    const body = (await req.json()) as Record<string, unknown>
    get = (key) => String(body[key] ?? '')
  } else {
    const form = await req.formData()
    get = (key) => String(form.get(key) ?? '')
  }

  return {
    email: normalizeEmail(get('email')),
    password: get('password'),
    confirm: get('confirm') || get('password_confirm'),
    fullName: clamp(get('full_name'), 120),
    country: clamp(get('country'), 2).toUpperCase(),
    useCase: clamp(get('use_case'), 140),
    accountType: get('account_type').trim(),
    plan: clamp(get('plan'), 40),
    months: clamp(get('months'), 2)
  }
}

/* GoTrue reports a duplicate address in the 400/422 band with the reason in
   the message rather than in a code, so this reads the message. Getting it
   wrong in the cautious direction is harmless: an unrecognised duplicate
   falls through to the generic branch, which tells the visitor to try signing
   in, and that is the right advice either way. */
function isDuplicate(error: AuthError) {
  return (
    (error.status === 400 || error.status === 422 || error.status === 409) &&
    /already|registered|exists|duplicate/i.test(error.message || '')
  )
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to create an account.', 405)
  }

  /* A session-less endpoint that sends mail on the strength of a request body
     alone, so it gets the same origin check as the other mutations. Same-origin
     form and JSON posts both send Origin, so the plain-HTML fallback works. */
  try {
    verifyRequestOrigin(req)
  } catch {
    return fail('That request did not come from this site.', 403)
  }

  let reg: Registration

  try {
    reg = await readRegistration(req)
  } catch {
    return fail('That request could not be read. Please try again.', 400)
  }

  if (!ACCOUNT_TYPES.includes(reg.accountType as (typeof ACCOUNT_TYPES)[number])) {
    return fail('Choose how you are registering.', 422, 'account_type')
  }
  if (reg.fullName.length < 2) return fail('Enter the name this account belongs to.', 422, 'full_name')
  if (!/^[A-Z]{2}$/.test(reg.country)) return fail('Select a country.', 422, 'country')
  if (reg.useCase.length < 3) return fail('Tell us roughly what you need it for.', 422, 'use_case')
  if (!reg.email) return fail('Enter your work email address.', 422, 'email')
  if (!looksLikeEmail(reg.email)) return fail('That email address does not look right.', 422, 'email')
  if (!reg.password) return fail('Choose a password.', 422, 'password')
  if (reg.password.length < MIN_PASSWORD) {
    return fail(`Use at least ${MIN_PASSWORD} characters.`, 422, 'password')
  }
  /* Checked in the browser too. Repeated here because the browser copy is a
     convenience and this one is the rule — and a mistyped password on a
     brand-new account locks somebody out of an address they have just proved
     they own, which is a support ticket rather than a retry. Only enforced
     when the field is present, so the no-JavaScript post still works. */
  if (reg.confirm && reg.confirm !== reg.password) {
    return fail('Both passwords need to match.', 422, 'password')
  }

  const signals = requestSignals(req, context)

  /* Issues the challenge, mails it, and reports whether the mail actually
     left. Shared by the fresh-account and already-registered paths below,
     which need identical behaviour from here on: the account exists either
     way, and the next thing that has to happen is a code in an inbox. */
  const challenge = async (email: string, name: string | null) => {
    const issued = await issueCode(email, 'signup', signals.ip)

    /* Refused for a cooldown or the hourly cap. The account is made and a
       code from a moment ago is still live, so this is not a failure — the
       page says "check your inbox", which is true, and the resend button on
       the far side reports the wait. */
    if (!issued.ok) return { sent: false, minutes: 0, throttled: true }

    const sent = await sendVerificationEmail({
      to: email,
      name,
      code: issued.code,
      token: issued.token,
      minutes: issued.minutes,
      plan: reg.plan,
      months: reg.months
    })

    return { sent, minutes: issued.minutes, throttled: false }
  }

  try {
    /* full_name is the field Identity reads for the display name; the rest is
       ours and comes back on the user record as plain metadata. No mail is
       sent by this call, which is the reason it is the admin API and not
       signup() — the message the customer gets is the one below. */
    const user = await admin.createUser({
      email: reg.email,
      password: reg.password,
      data: {
        user_metadata: {
          full_name: reg.fullName,
          account_type: reg.accountType,
          country: reg.country,
          use_case: reg.useCase,
          signup_plan: reg.plan || null,
          signup_months: reg.months || null
        }
      }
    })

    await upsertAccount({
      email: reg.email,
      identityUserId: user?.id ?? null,
      fullName: reg.fullName,
      signupPlan: reg.plan || null,
      signupMonths: reg.months || null
    })

    const { sent, minutes } = await challenge(reg.email, reg.fullName)

    return json({
      ok: true,
      verified: false,
      confirmationSent: sent,
      email: user?.email ?? reg.email,
      minutes
    })
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      return fail(
        'Accounts are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will set yours up by hand.',
        503,
        undefined,
        'unavailable'
      )
    }

    if (error instanceof AuthError) {
      /* Already registered.

         Two different situations wearing one error, and they want opposite
         answers. An address that finished confirming belongs to somebody who
         has an account and a password — send them to sign-in.

         An address that never confirmed is almost always the same person
         coming back to a step they abandoned, so it gets another code rather
         than a dead end. What it explicitly does **not** get is the new
         password from this request: rewriting the credentials on an existing
         account from an unauthenticated form is an account takeover, however
         reasonable the intent. So the account keeps the password it was made
         with, and the response says so. */
      if (isDuplicate(error)) {
        let account = null

        try {
          account = await findAccount(reg.email)
        } catch {
          account = null
        }

        if (account && !account.email_verified_at) {
          const { sent, minutes } = await challenge(reg.email, account.full_name || reg.fullName)

          return json({
            ok: true,
            verified: false,
            confirmationSent: sent,
            existing: true,
            email: reg.email,
            minutes
          })
        }

        return fail(
          'That address already has an account. Sign in instead, or reset the password if it has been forgotten.',
          409,
          'email',
          'exists'
        )
      }

      switch (error.status) {
        case 403:
          return fail('Registration is closed right now. Contact support for an invite.', 403)
        case 422:
          return fail(error.message || 'Check the email and password and try again.', 422)
        default:
          return fail(
            error.message || 'That did not work. Try again, or sign in if you already have an account.',
            error.status && error.status >= 400 && error.status < 500 ? error.status : 502
          )
      }
    }

    return fail('Something went wrong creating the account. Please try again.', 500)
  }
}
