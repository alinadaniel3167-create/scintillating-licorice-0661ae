/* ==========================================================================
   POST /api/confirm — redeem an email confirmation token.

   Netlify Identity mails a link back to the site with the token in the URL
   fragment. The welcome page reads it and posts it here; this is the only
   place the token is redeemed, because doing it in the browser would mean
   bundling the Identity client into a site that has no build step.

   Responds with JSON the welcome page can act on:
     { ok: true,  email: string }
     { ok: false, error: string, expired?: boolean }
   ========================================================================== */

import { confirmEmail, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'

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
    return json({ ok: true, email: user?.email ?? '' })
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
