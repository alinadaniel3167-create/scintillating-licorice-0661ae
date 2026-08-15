/* ==========================================================================
   POST /api/register — create a CloakShield Pro account.

   The public site is static, so registration is the one thing that needs a
   server. Passwords are never handled here beyond forwarding them to Netlify
   Identity, which owns hashing, confirmation email and session cookies.

   Responds with JSON the register page can act on:
     { ok: true,  verified: boolean, email: string }
     { ok: false, error: string, field?: 'email' | 'password' }
   ========================================================================== */

import { signup, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'

const MIN_PASSWORD = 8

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  })
}

function fail(error: string, status: number, field?: 'email' | 'password') {
  return json(field ? { ok: false, error, field } : { ok: false, error }, status)
}

/* Deliberately loose — Identity is the real authority on what it will accept.
   This only catches the obvious typo before a network round trip. */
function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

/* Accepts both a JSON body (the register page) and a urlencoded one, so the
   endpoint still works if the form is ever submitted without JavaScript. */
async function readCredentials(req: Request) {
  const type = req.headers.get('content-type') || ''

  if (type.includes('application/json')) {
    const body = (await req.json()) as Record<string, unknown>
    return {
      email: String(body.email ?? '').trim(),
      password: String(body.password ?? '')
    }
  }

  const form = await req.formData()
  return {
    email: String(form.get('email') ?? '').trim(),
    password: String(form.get('password') ?? '')
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to create an account.', 405)
  }

  let email = ''
  let password = ''

  try {
    const creds = await readCredentials(req)
    email = creds.email
    password = creds.password
  } catch {
    return fail('That request could not be read. Please try again.', 400)
  }

  if (!email) return fail('Enter your work email address.', 422, 'email')
  if (!looksLikeEmail(email)) return fail('That email address does not look right.', 422, 'email')
  if (!password) return fail('Choose a password.', 422, 'password')
  if (password.length < MIN_PASSWORD) {
    return fail(`Use at least ${MIN_PASSWORD} characters.`, 422, 'password')
  }

  try {
    const user = await signup(email, password)

    /* Autoconfirm on  → the user is already logged in.
       Autoconfirm off → a confirmation email is on its way and there is no
       session yet. The page tells them which of the two happened. */
    return json({
      ok: true,
      verified: Boolean(user?.emailVerified),
      email: user?.email ?? email
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
