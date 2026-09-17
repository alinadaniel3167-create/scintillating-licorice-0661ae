/* ==========================================================================
   POST /api/reset — redeem a reset token and set a new password.

   The other half of /api/recover. Identity mails a link back to the site root
   with the token in the URL fragment; js/site.js forwards it to /reset.html,
   which posts the token here together with the new password.

   recoverPassword() does all three things in one call: it redeems the token,
   writes the password and opens a session. That matters for the same reason
   /api/confirm redeems its token server-side — the alternative is the browser
   flow, which needs the Identity client bundled into a site that has no build
   step, and a two-call version would leave a window where the token is spent
   but the password is not yet written.

   Because a session comes back with it, the page that calls this navigates
   with a full page load afterwards, exactly as sign-in does: the cookies are
   set on the response to this request and have to travel with the next one.

   Responds with:
     { ok: true,  email: string, next: string }
     { ok: false, error: string, field?: Field, expired?: boolean }
   ========================================================================== */

import {
  recoverPassword,
  verifyRequestOrigin,
  AuthError,
  MissingIdentityError
} from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { json, readBody } from '../lib/http.mjs'

/* Matched to the register function. A reset that accepted a weaker password
   than registration would be a way around the rule rather than an exception
   to it. */
const MIN_PASSWORD = 8

type Field = 'password' | 'confirm'

function bad(error: string, status: number, field?: Field, expired?: boolean) {
  const body: Record<string, unknown> = { ok: false, error }
  if (field) body.field = field
  if (expired) body.expired = true
  return json(body, status)
}

export default async (req: Request, _context: Context) => {
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
  const password = String(body.password || '')
  const confirm = String(body.confirm || '')

  if (!token) {
    return bad('This link is missing its reset token. Request a new one below.', 422, undefined, true)
  }
  if (!password) return bad('Choose a new password.', 422, 'password')
  if (password.length < MIN_PASSWORD) {
    return bad(`Use at least ${MIN_PASSWORD} characters.`, 422, 'password')
  }
  /* Checked in the browser too. Repeated here because the browser copy is a
     convenience and this one is the rule — a mistyped password nobody can
     reproduce is a second reset request at best. */
  if (confirm !== password) {
    return bad('Both passwords need to match.', 422, 'confirm')
  }

  try {
    const user = await recoverPassword(token, password)

    return json({
      ok: true,
      email: user?.email ?? '',
      name: user?.name ?? '',
      next: '/dashboard.html'
    })
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      return bad(
        'Password resets are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will reset yours by hand.',
        503
      )
    }

    if (error instanceof AuthError) {
      /* A token that has expired, one that has already been spent and one
         that was never valid all land in the 401/404/422 band, and the fix
         is the same for all three: ask for another link. The reset form is
         on the same page, so "below" is accurate.

         422 is the ambiguous one — it is also how Identity reports a password
         it will not accept. The length and match rules above have already
         run, so anything left is Identity's own policy and its message is
         more use to the visitor than ours would be. */
      if (error.status === 422 && /password/i.test(error.message || '')) {
        return bad(error.message, 422, 'password')
      }

      return bad(
        'This reset link has expired or has already been used. Request a new one below.',
        error.status && error.status >= 400 && error.status < 500 ? error.status : 502,
        undefined,
        true
      )
    }

    return bad('Something went wrong setting that password. Please try again.', 500)
  }
}
