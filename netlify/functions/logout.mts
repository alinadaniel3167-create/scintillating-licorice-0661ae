/* ==========================================================================
   POST /api/logout — end the session.

   Clearing localStorage['cs-account'] used to be the whole of signing out.
   Now that Identity holds a real session, the cookies have to go too, or the
   next page load would sign the visitor straight back in from the server.
   ========================================================================== */

import { logout, verifyRequestOrigin, AuthError, MissingIdentityError } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { fail, json } from '../lib/http.mjs'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to sign out.', 405)
  }

  try {
    verifyRequestOrigin(req)
  } catch {
    return fail('That request did not come from this site.', 403)
  }

  try {
    await logout()
  } catch (error) {
    if (!(error instanceof AuthError) && !(error instanceof MissingIdentityError)) throw error
    /* logout() deletes the cookies even when the token invalidation call
       fails, so there is nothing useful to report back — the visitor is out
       either way and saying otherwise would only invite them to retry. */
  }

  return json({ ok: true })
}
