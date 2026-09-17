/* ==========================================================================
   POST /api/recover — ask for a password reset link.

   The counterpart to /api/register: registration is the only way an address
   gets onto the account list, and this is the only way back in when the
   password that went with it is gone. Identity owns the token and Identity
   sends the mail, using the template at /email-templates/recovery.html; this
   function exists so the site never has to put the Identity client in a
   browser that has no bundler.

   Two things it deliberately will not do.

   It will not say whether the address is on the account list. A reset form
   that answers "no such account" is an address oracle, and the addresses on
   this particular list are people running paid traffic. Every readable
   outcome — sent, unknown address, rate limited — comes back the same way, so
   the response below is neutral by construction rather than by remembering to
   be careful in each branch.

   And it will not claim an email is on its way when one cannot be. If
   Identity is not configured on this deploy there is no mailer, no token and
   no link, and the honest answer is a 503 that names the support address. The
   screen that says "a reset link is on its way" over a link that could never
   arrive is worse than an error: the customer waits, checks spam, waits
   again, and only then writes in.

   Responds with:
     { ok: true,  accepted: true }
     { ok: false, error: string, field?: 'email', code?: string }
   ========================================================================== */

import {
  requestPasswordRecovery,
  verifyRequestOrigin,
  AuthError,
  MissingIdentityError
} from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { fail, json, readBody } from '../lib/http.mjs'

/* Same loose shape check the register function uses. Identity is the real
   authority on what it will accept; this only catches the obvious typo
   before a network round trip. */
function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

/* The one success response, used for every outcome that is not a failure of
   this site. Whether the address was on the list is not in it. */
function accepted() {
  return json({ ok: true, accepted: true })
}

/* The shared fail() takes a machine-readable code as its third argument, not a
   field name, and the form keys its inline errors off `field`. So the one
   field this endpoint has gets its own helper rather than borrowing that slot
   and landing the message next to no input at all. */
function failField(error: string, status: number) {
  return json({ ok: false, error, field: 'email' }, status)
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to request a reset link.', 405)
  }

  /* This endpoint sends mail on the strength of a request body alone, so it
     gets the same origin check as the other mutations. Without it another
     site could quietly have reset mail sent to addresses it is guessing at. */
  try {
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

  if (!email) return failField('Enter the email address on the account.', 422)
  if (!looksLikeEmail(email)) {
    return failField('That email address does not look right.', 422)
  }

  try {
    await requestPasswordRecovery(email)
    return accepted()
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      /* No Identity, no mailer. Say so rather than promising a link. */
      return fail(
        'Password resets are not available on this deploy yet. Email Cloakshield.pro@outlook.com and we will reset yours by hand.',
        503,
        'unavailable'
      )
    }

    if (error instanceof AuthError) {
      /* 404 is "no such address" and 400/422 are Identity's own view of the
         address. All three are the caller's business only in the sense that
         they should try a different address — none of them is confirmation
         that an account does or does not exist, so none of them is echoed. */
      if (error.status === 404 || error.status === 400 || error.status === 422) {
        return accepted()
      }

      /* 429 means Identity is throttling repeat requests for this address.
         A link is already in flight from the previous attempt, which is the
         same thing the visitor is being told either way. */
      if (error.status === 429) {
        return accepted()
      }

      return fail(
        'We could not reach the identity service to send that link. Try again in a minute, or email Cloakshield.pro@outlook.com.',
        502
      )
    }

    return fail('Something went wrong sending that link. Please try again.', 500)
  }
}
