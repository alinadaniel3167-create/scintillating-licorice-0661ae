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

   Responds with:
     { ok: true,  email: string, next: string }
     { ok: false, error: string, field?: 'email' | 'password' }
   ========================================================================== */

import { login, verifyRequestOrigin, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { fail, json, readBody } from '../lib/http.mjs'

/* Where the form may send someone afterwards. An open redirect on a login
   endpoint is how a phishing page borrows a real domain, so the destination
   is a fixed choice rather than a URL from the request. */
const DESTINATIONS: Record<string, string> = {
  dashboard: '/dashboard.html',
  checkout: '/checkout.html',
  home: '/'
}

export default async (req: Request, _context: Context) => {
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

  const email = String(body.email || '').trim()
  const password = String(body.password || '')
  const target = String(body.next || 'dashboard').trim()

  if (!email) return fail('Enter the email address on the account.', 422, 'email')
  if (!password) return fail('Enter your password.', 422, 'password')

  try {
    const user = await login(email, password)

    return json({
      ok: true,
      email: user?.email ?? email,
      name: user?.name ?? '',
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
         credentials. Both get a deliberately vague message — telling a
         stranger which addresses exist is a favour to whoever is guessing. */
      if (error.status === 400 && /confirm/i.test(error.message || '')) {
        return fail(
          'This address has not been confirmed yet. Open the link in the confirmation email first.',
          403,
          'email'
        )
      }

      return fail('That email address and password do not match an account.', 401, 'password')
    }

    return fail('Something went wrong signing in. Please try again.', 500)
  }
}
