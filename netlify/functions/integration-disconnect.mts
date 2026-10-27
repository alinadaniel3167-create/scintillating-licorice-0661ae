/* ==========================================================================
   POST /api/integration-disconnect — forget a customer's key.

   Deliberately a delete and not a status change. The row's reason for
   existing is the credential inside it, and a customer who disconnects a
   platform is asking us to stop holding their tracker's admin key — leaving
   an encrypted copy behind under a 'disabled' flag would be answering a
   different question than the one they asked.

   The campaign count and the sync history go with it, which is the right
   trade: none of it is money, none of it is audited, and nothing downstream
   reads it. Compare orders, where a cancelled row is kept forever because a
   payment may still arrive against it.
   ========================================================================== */

import type { Context } from '@netlify/functions'
import { json, fail, readBody } from '../lib/http.mjs'
import { gate } from '../lib/gate.mjs'
import { deleteIntegration } from '../lib/integrations.mjs'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to disconnect a platform.', 405)
  }

  /* No plan requirement on this one. A customer whose term has lapsed must
     still be able to withdraw a key we are holding — making that conditional
     on paying would be the wrong thing by a distance. */
  const result = await gate(req, { mutation: true, entitled: false })
  if (!result.ok) return result.response

  const { caller } = result

  let body: Record<string, string>
  try {
    body = await readBody(req)
  } catch {
    return fail('That request could not be read.', 400)
  }

  const id = Number(String(body.id || '').trim())
  if (!Number.isInteger(id) || id <= 0) {
    return fail('That integration does not exist.', 422, 'id')
  }

  const removed = await deleteIntegration(id, caller.identityUserId, caller.email)
  if (!removed) return fail('That integration does not exist.', 404, 'not_found')

  return json({ ok: true, id })
}
