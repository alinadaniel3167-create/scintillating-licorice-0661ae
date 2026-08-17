/* ==========================================================================
   POST /api/register — create a CloakShield Pro account.

   The public site is static, so registration is the one thing that needs a
   server. Passwords are never handled here beyond forwarding them to Netlify
   Identity, which owns hashing, confirmation email and session cookies. The
   rest of the form is profile metadata and rides along on the signup call as
   user metadata.

   Responds with JSON the register page can act on:
     { ok: true,  verified: boolean, email: string }
     { ok: true,  verified: false, slow: true, email: string }
     { ok: false, error: string, field?: Field }

   The `slow` case means Identity took the signup but did not answer in time.
   The account exists, so it is reported as a success and the visitor carries on
   to the verification step. See identitySignup below.
   ========================================================================== */

import { AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'

const MIN_PASSWORD = 8

/* The library's signup() aborts its own fetch after a hard-coded 5000ms, and
   with autoconfirm off GoTrue sends the confirmation email *inside* that
   response. A slow mail server therefore surfaced to the visitor as
   "Identity request to /.netlify/identity/signup timed out after 5000ms" even
   though the account had already been created. We post to the same endpoint
   with the same body shape and a timeout that fits the function budget
   instead — synchronous functions get 60s, so 20s leaves plenty of room for
   the response to still be reported rather than cut off by the platform. */
const IDENTITY_TIMEOUT_MS = 20000

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

/* Identity accepted the request but did not answer in time. GoTrue commits the
   user row before it sends the mail, so the account almost certainly exists —
   this is not a failure to report to the visitor as one. */
class SlowIdentityError extends Error {}

/* The signup endpoint answers with GoTrue's own snake_case record, not the
   library's camelCase User. */
interface GoTrueUser {
  email?: string
  confirmed_at?: string | null
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

/* Resolved the way the library resolves it, in the same order, so a deploy
   preview keeps talking to whatever endpoint it talked to before. An injected
   context already carries the full path; the other two are origins. */
function identityEndpoint(): string {
  const g = globalThis as {
    netlifyIdentityContext?: { url?: string }
    Netlify?: { context?: { url?: string } }
  }

  const injected = g.netlifyIdentityContext?.url
  if (injected) return injected

  const origin =
    g.Netlify?.context?.url ?? (typeof process !== 'undefined' ? process.env?.URL : undefined)
  if (!origin) throw new MissingIdentityError()

  return new URL('/.netlify/identity', origin).href
}

/* Stands in for the library's signup(), which is otherwise exactly what we
   want: same endpoint, same `{ email, password, data }` body, same URL derived
   from the environment. Only the timeout differs. Staying same-origin matters —
   the CSP sets connect-src 'self' and the /api/register rewrite depends on it. */
async function identitySignup(reg: Registration): Promise<GoTrueUser> {
  const endpoint = identityEndpoint()

  let res: Response

  try {
    res = await fetch(`${endpoint}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: reg.email,
        password: reg.password,
        /* full_name is the field Identity reads for the display name; the rest
           is ours and comes back on the user record as plain metadata. */
        data: {
          full_name: reg.fullName,
          account_type: reg.accountType,
          country: reg.country,
          use_case: reg.useCase,
          signup_plan: reg.plan || null,
          signup_months: reg.months || null
        }
      }),
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS)
    })
  } catch (error) {
    const name = (error as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') throw new SlowIdentityError()
    throw error
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      msg?: string
      error_description?: string
    }
    throw new AuthError(
      body.msg ?? body.error_description ?? `Signup failed (${String(res.status)})`,
      res.status
    )
  }

  return (await res.json()) as GoTrueUser
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
    const user = await identitySignup(reg)

    /* Autoconfirm on  → confirmed_at is set and the user is already logged in.
       Autoconfirm off → a confirmation email is on its way and there is no
       session yet. The page tells them which of the two happened. */
    return json({
      ok: true,
      verified: Boolean(user?.confirmed_at),
      email: user?.email ?? reg.email
    })
  } catch (error) {
    if (error instanceof SlowIdentityError) {
      /* Not a failure: the account is created before the mail goes out, so send
         them on to the verification step rather than into a retry loop that
         only mails them a second copy of the same confirmation. */
      console.error(`identity signup exceeded ${String(IDENTITY_TIMEOUT_MS)}ms`)
      return json({ ok: true, verified: false, slow: true, email: reg.email })
    }

    if (error instanceof MissingIdentityError) {
      return fail(
        'Accounts are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will set yours up by hand.',
        503
      )
    }

    if (error instanceof AuthError) {
      /* Never surface error.message: it carries library and GoTrue internals,
         which is how a timeout diagnostic ended up in front of a visitor. Log
         it, show site copy. */
      console.error('identity signup rejected', error.status, error.message)

      /* GoTrue reports an existing address in the 400 band. They do not need to
         register again — they need the step they never finished. */
      if (/already (been )?registered|already exists/i.test(error.message || '')) {
        return fail(
          'That address already has an account. Finish verifying your email to carry on.',
          409,
          'email'
        )
      }

      switch (error.status) {
        case 403:
          return fail('Registration is closed right now. Contact support for an invite.', 403)
        case 422:
          return fail('Check the email and password and try again.', 422)
        default:
          return fail(
            'That did not work. Try again, or finish verifying your email if you already have an account.',
            error.status && error.status >= 400 && error.status < 500 ? error.status : 502
          )
      }
    }

    console.error('identity signup failed', error)
    return fail('Something went wrong creating the account. Please try again.', 500)
  }
}
