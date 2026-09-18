/* ==========================================================================
   POST /api/register — create a CloakShield Pro account.

   The public site is static, so registration is the one thing that needs a
   server. Passwords are never handled here beyond forwarding them to Netlify
   Identity, which owns hashing, confirmation email and session cookies. The
   rest of the form is profile metadata and rides along on the signup call as
   user metadata.

   Responds with JSON the register page can act on:
     { ok: true,  verified: boolean, confirmationSent: boolean, email: string }
     { ok: false, error: string, field?: Field }

   confirmationSent is the one field worth explaining. The next page in the
   flow used to tell every new account that a confirmation link was on its
   way, which is only true when autoconfirm is off. With it on, Identity
   sends nothing and signs the visitor straight in, and the old copy sent
   them to wait for an email that was never going to arrive. So this endpoint
   reports what actually happened rather than what usually happens, and
   /welcome.html reads it.

   It also decides which of the two possible first emails an account gets,
   and the rule is that it gets exactly one. With autoconfirm off, Identity
   mails the confirmation link from email-templates/confirmation.html and
   this function sends nothing — a second "welcome" arriving beside a "please
   confirm" is noise that makes the real one easier to miss. With autoconfirm
   on there is no link and no Identity mail at all, so the welcome is sent
   from here instead. The other branch lives in /api/confirm, which sends it
   when the token is redeemed.
   ========================================================================== */

import { signup, getSettings, verifyRequestOrigin, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { sendWelcomeEmail } from '../lib/account-mail.mjs'

const MIN_PASSWORD = 8

type Field = 'email' | 'password' | 'full_name' | 'country' | 'use_case' | 'account_type'

/* The three options the form offers, mirrored here so a hand-crafted request
   cannot write something else into the account record. */
const ACCOUNT_TYPES = ['individual', 'sole_proprietor', 'legal_entity'] as const

interface Registration {
  email: string
  password: string
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

function fail(error: string, status: number, field?: Field) {
  return json(field ? { ok: false, error, field } : { ok: false, error }, status)
}

/* Deliberately loose — Identity is the real authority on what it will accept.
   This only catches the obvious typo before a network round trip. */
function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
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
    email: get('email').trim(),
    password: get('password'),
    fullName: clamp(get('full_name'), 120),
    country: clamp(get('country'), 2).toUpperCase(),
    useCase: clamp(get('use_case'), 140),
    accountType: get('account_type').trim(),
    plan: clamp(get('plan'), 40),
    months: clamp(get('months'), 2)
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to create an account.', 405)
  }

  /* Identity documents signup as needing CSRF protection when it is called
     from a server endpoint. Same-origin form and JSON posts both send Origin,
     so the plain-HTML fallback still works. */
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

  try {
    /* full_name is the field Identity reads for the display name; the rest is
       ours and comes back on the user record as plain metadata. */
    const user = await signup(reg.email, reg.password, {
      full_name: reg.fullName,
      account_type: reg.accountType,
      country: reg.country,
      use_case: reg.useCase,
      signup_plan: reg.plan || null,
      signup_months: reg.months || null
    })

    /* Autoconfirm on  → the user is already logged in.
       Autoconfirm off → a confirmation email is on its way and there is no
       session yet. The page tells them which of the two happened. */
    const verified = Boolean(
      (user as { emailVerified?: boolean })?.emailVerified ?? user?.confirmedAt
    )

    /* Whether a confirmation email was really dispatched, from the two places
       that can answer it: the timestamp Identity puts on the new user record,
       and failing that the project's own autoconfirm setting — with it off, an
       unconfirmed signup means mail went out.

       The settings read is best-effort on purpose. It is a second network
       call after the account has already been created, and an account that
       exists is not worth failing over a message that is one word less
       precise. A null answer collapses to "we are not claiming mail was
       sent", which is the safe direction: the welcome page then talks about
       the link without promising its arrival. */
    let autoconfirm: boolean | null = null
    try {
      autoconfirm = (await getSettings()).autoconfirm
    } catch {
      autoconfirm = null
    }

    const confirmationSent = verified
      ? false
      : Boolean(user?.confirmationSentAt) || autoconfirm === false

    /* Autoconfirm path only: nothing else is going to greet this account.
       Best-effort, and never allowed to fail a signup that has already
       happened — see the header note. */
    if (verified) {
      await sendWelcomeEmail({
        to: user?.email ?? reg.email,
        name: reg.fullName,
        plan: reg.plan,
        months: reg.months,
        confirmed: false
      })
    }

    return json({
      ok: true,
      verified,
      confirmationSent,
      email: user?.email ?? reg.email
    })
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      return fail(
        'Accounts are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will set yours up by hand.',
        503
      )
    }

    if (error instanceof AuthError) {
      switch (error.status) {
        case 403:
          return fail('Registration is closed right now. Contact support for an invite.', 403)
        case 422:
          return fail(error.message || 'Check the email and password and try again.', 422)
        default:
          /* 400 covers "user already registered", which GoTrue reports here. */
          return fail(
            error.message || 'That did not work. Try again, or sign in if you already have an account.',
            error.status && error.status >= 400 && error.status < 500 ? error.status : 502
          )
      }
    }

    return fail('Something went wrong creating the account. Please try again.', 500)
  }
}
