/* ==========================================================================
   POST /api/integration-connect — hold a customer's API key, and prove it works.

   The order here is the whole design: the credential is verified against the
   platform's own API *before* it is written, and a key the platform refuses
   is never stored at all. The alternative — store first, verify on a later
   pass — leaves a table accumulating dead credentials, and leaves the
   customer looking at a card that says "connecting" for a key that was
   rejected three seconds after they pasted it.

   What a successful call means, exactly: this key was accepted by that
   platform, and its campaign list could be read. It does not mean traffic is
   flowing through CloakShield — there is no routing layer yet — and no
   response field here should be rendered as though it did. The panel's
   wording is held to the same line.

   Everything a self-hosted address has to survive before a request is made to
   it is in platform-api.mts; this function's job is to call safeOrigin()
   rather than to re-implement any of it.
   ========================================================================== */

import type { Context } from '@netlify/functions'
import { json, fail, readBody } from '../lib/http.mjs'
import { gate } from '../lib/gate.mjs'
import { platformById } from '../lib/platforms.mjs'
import { PlatformError, safeOrigin, verifyCredential, type Credential } from '../lib/platform-api.mjs'
import {
  countIntegrations,
  integrationsConfigured,
  publicRow,
  saveIntegration
} from '../lib/integrations.mjs'

/* A ceiling, not a product limit. Nobody runs twelve trackers; a request to
   connect a thirteenth is a loop or a script, and the cost of being wrong
   about that is one support email. Mirrors MAX_OPEN_ORDERS in order.mts. */
const MAX_INTEGRATIONS = 12

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to connect a platform.', 405)
  }

  const result = await gate(req, { mutation: true, entitled: true })
  if (!result.ok) return result.response

  const { caller } = result

  if (!integrationsConfigured()) {
    return fail(
      'Integrations are not configured on this deploy yet. Email Cloakshield.pro@outlook.com and we will connect it for you.',
      503,
      'not_configured'
    )
  }

  let body: Record<string, string>
  try {
    body = await readBody(req)
  } catch {
    return fail('That request could not be read.', 400)
  }

  const platform = platformById(String(body.platform || ''))
  if (!platform) return fail('That platform does not exist.', 422, 'platform')

  if (!platform.connectable) {
    return fail(
      `${platform.name} is set up by hand rather than with a key. Email Cloakshield.pro@outlook.com and we will walk it through with you.`,
      422,
      'not_connectable'
    )
  }

  /* Only the fields this platform actually declares are read off the body, so
     a request carrying an extra key cannot smuggle one into the stored
     credential. */
  const credential: Credential = {}
  for (const field of platform.fields) {
    if (field.name === 'baseUrl') continue
    const value = String(body[field.name] || '').trim()
    if (!value) {
      return fail(`${field.label} is required.`, 422, field.name)
    }
    if (value.length > 512) {
      return fail(`${field.label} is longer than any real key. Check what was pasted.`, 422, field.name)
    }
    ;(credential as Record<string, string>)[field.name] = value
  }

  let baseUrl: string | null = null
  if (platform.selfHosted) {
    try {
      baseUrl = await safeOrigin(String(body.baseUrl || ''))
    } catch (error) {
      if (error instanceof PlatformError) return fail(error.message, 422, error.code)
      throw error
    }
  }

  const label = String(body.label || '').trim().slice(0, 60) || null

  if ((await countIntegrations(caller.identityUserId, caller.email)) >= MAX_INTEGRATIONS) {
    return fail(
      'There are already more connected platforms on this account than we expect. Email Cloakshield.pro@outlook.com and we will sort it out.',
      429,
      'too_many'
    )
  }

  /* The verification call. A PlatformError is a sentence the customer can act
     on — a refused key, an address with no API behind it, an instance that
     did not answer — so it comes back as a 422 with its own code and the row
     is not written. */
  let campaigns: number | null = null
  try {
    const verified = await verifyCredential(platform, credential, baseUrl)
    campaigns = verified.campaigns
  } catch (error) {
    if (error instanceof PlatformError) {
      return fail(error.message, 422, error.code)
    }
    return fail(
      `Could not reach ${platform.name} to check that key. Please try again.`,
      502,
      'verify_failed'
    )
  }

  try {
    const row = await saveIntegration({
      identityUserId: caller.identityUserId,
      email: caller.email,
      platform: platform.id,
      label,
      baseUrl,
      credential,
      campaigns
    })

    return json({ ok: true, integration: publicRow(row) })
  } catch {
    /* The key was good and we could not store it. Saying so is better than a
       generic failure, because the customer's next move is to try again
       rather than to go hunting for a new key. */
    return fail(
      `${platform.name} accepted that key but we could not save it. Please try again.`,
      500,
      'save_failed'
    )
  }
}
