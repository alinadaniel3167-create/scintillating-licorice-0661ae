/* ==========================================================================
   POST /api/integration-sync — ask the platform again.

   The one thing that makes a connected card honest over time. A key that
   worked when it was pasted stops working the moment somebody revokes it,
   rotates it, or takes the instance down, and nothing about that is visible
   from here — which is the same failure mode /api/health was written for on
   the MEXC key. So the card carries a real timestamp and this is what moves
   it.

   A failure is recorded rather than returned and forgotten: recordError()
   writes the reason onto the row, the card turns amber and says why, and the
   previous campaign count is deliberately kept so "refused the key, last
   worked at 31 campaigns" is still readable. The response reports the same
   thing, so the panel does not have to re-fetch to find out what happened.

   It is a POST because it changes the row and because a GET that reaches out
   to a customer-supplied host is the kind of thing that ends up in a
   prefetcher. Same reasoning as the Origin check on every other mutation.
   ========================================================================== */

import type { Context } from '@netlify/functions'
import { json, fail, readBody } from '../lib/http.mjs'
import { gate } from '../lib/gate.mjs'
import { platformById } from '../lib/platforms.mjs'
import { PlatformError, verifyCredential } from '../lib/platform-api.mjs'
import {
  findIntegration,
  integrationsConfigured,
  publicRow,
  recordError,
  recordSync,
  unseal
} from '../lib/integrations.mjs'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to refresh an integration.', 405)
  }

  const result = await gate(req, { mutation: true, entitled: true })
  if (!result.ok) return result.response

  const { caller } = result

  if (!integrationsConfigured()) {
    return fail('Integrations are not configured on this deploy.', 503, 'not_configured')
  }

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

  /* Ownership is inside the lookup, so an id belonging to somebody else comes
     back as "does not exist" rather than as a refusal that confirms it does. */
  const row = await findIntegration(id, caller.identityUserId, caller.email)
  if (!row) return fail('That integration does not exist.', 404, 'not_found')

  const platform = platformById(row.platform)
  if (!platform) return fail('That platform is no longer supported.', 422, 'platform')

  /* A row that will not decrypt is a row whose key has been rotated out from
     under it. The customer has to paste the credential again, and saying so
     is the only useful answer — retrying cannot fix it. */
  const credential = unseal(row)
  if (!credential) {
    await recordError(id, 'The stored key could not be read. Connect this platform again.')
    const refreshed = await findIntegration(id, caller.identityUserId, caller.email)
    return json({
      ok: false,
      error: 'The stored key could not be read. Connect this platform again.',
      code: 'credential_unreadable',
      integration: refreshed ? publicRow(refreshed) : null
    }, 422)
  }

  try {
    const verified = await verifyCredential(platform, credential, row.base_url)
    await recordSync(id, verified.campaigns)
  } catch (error) {
    const reason =
      error instanceof PlatformError
        ? error.message
        : `Could not reach ${platform.name}. Try again in a moment.`

    await recordError(id, reason)

    const refreshed = await findIntegration(id, caller.identityUserId, caller.email)
    return json(
      {
        ok: false,
        error: reason,
        code: error instanceof PlatformError ? error.code : 'verify_failed',
        integration: refreshed ? publicRow(refreshed) : null
      },
      error instanceof PlatformError ? 422 : 502
    )
  }

  const refreshed = await findIntegration(id, caller.identityUserId, caller.email)
  return json({ ok: true, integration: refreshed ? publicRow(refreshed) : null })
}
