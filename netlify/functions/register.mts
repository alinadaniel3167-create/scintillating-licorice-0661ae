/* ==========================================================================
   POST /api/register — create a CloakShield Pro account.

   The public site is static, so registration is the one thing that needs a
   server. Passwords are never handled here beyond forwarding them to Netlify
   Identity, which owns hashing, confirmation email and session cookies. The
   rest of the form is profile metadata and rides along on the signup call as
   user metadata.

   Responds with JSON the register page can act on:
     { ok: true,  verified: boolean, email: string }
     { ok: false, error: string, field?: Field }
   ========================================================================== */

import { signup, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'

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

    return json({
      ok: true,
      verified,
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
