/* ==========================================================================
   Who is allowed to call an integrations endpoint.

   Four endpoints ask the same three questions in the same order — is this a
   same-origin request, is there a session behind it, and has this account
   paid for a live plan — and the order matters, because each answer is the
   precondition for the next being worth asking. Written once here rather than
   four times in the functions, so there is no endpoint that can drift into
   checking two of the three.

   A session already implies a confirmed email address: /api/login is the only
   place that gate is enforced and it takes the session back from an account
   that has not redeemed its code. So getUser() returning a user is the whole
   identity check, exactly as it is in order.mts.
   ========================================================================== */

import { getUser, verifyRequestOrigin } from '@netlify/identity'
import { fail } from './http.mjs'
import { hasActivePlan } from './store.mjs'

export interface Caller {
  identityUserId: string
  email: string
  name: string
}

/* Either the caller, or the response to send instead. A discriminated union
   rather than a throw, so the functions stay linear and every refusal is a
   visible return at the point it is decided. */
export type GateResult = { ok: true; caller: Caller } | { ok: false; response: Response }

export interface GateOptions {
  /* POST endpoints change state on the strength of a cookie, so the Origin
     has to be checked or another site could drive them from a visitor's
     browser. GET /api/integrations reads and is exempt. */
  mutation: boolean
  /* Whether a live plan is required. The list endpoint deliberately does not
     require one: the panel has to be able to render the locked state, and it
     needs the catalogue to do that. */
  entitled: boolean
}

export async function gate(req: Request, options: GateOptions): Promise<GateResult> {
  if (options.mutation) {
    try {
      verifyRequestOrigin(req)
    } catch {
      return { ok: false, response: fail('That request did not come from this site.', 403) }
    }
  }

  const user = await getUser()
  if (!user) {
    return {
      ok: false,
      response: fail('Sign in to manage integrations.', 401, 'signin_required')
    }
  }

  const email = String(user.email || '')
  if (!email) {
    return { ok: false, response: fail('This account has no email address on file.', 422) }
  }

  if (options.entitled && !(await hasActivePlan(user.id, email))) {
    return {
      ok: false,
      response: fail(
        'Connecting a platform needs an active plan. Activate one from the workspace and this unlocks straight away.',
        403,
        'plan_required'
      )
    }
  }

  return {
    ok: true,
    caller: {
      identityUserId: user.id,
      email,
      name: user.name || String(user.userMetadata?.full_name || '')
    }
  }
}
