/* ==========================================================================
   GET /api/integrations — the catalogue, and what this account has connected.

   One call populates the whole panel, because the panel needs both halves at
   once: the five platforms it can offer, and the rows that say which of them
   are live. Returning them separately would mean two round trips and a window
   in which the page knows about a connection it cannot name.

   `entitled` is reported rather than enforced here on purpose. A signed-in
   customer without a live plan still sees the panel — the console is
   deliberately readable before it is usable, which is what the lock ribbon on
   dashboard.html says — so this endpoint answers for them too and the browser
   renders the connect buttons as unavailable. The endpoints that actually
   write a credential are the ones that require the plan.

   No credential leaves here. publicRow() in integrations.mts is the only
   shape this returns, and the cipher columns are not in it.
   ========================================================================== */

import type { Context } from '@netlify/functions'
import { json, fail } from '../lib/http.mjs'
import { gate } from '../lib/gate.mjs'
import { publicCatalogue } from '../lib/platforms.mjs'
import {
  integrationsConfigured,
  listIntegrations,
  publicRow
} from '../lib/integrations.mjs'
import { hasActivePlan } from '../lib/store.mjs'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'GET') {
    return fail('Use GET to read integrations.', 405)
  }

  const result = await gate(req, { mutation: false, entitled: false })
  if (!result.ok) return result.response

  const { caller } = result

  const entitled = await hasActivePlan(caller.identityUserId, caller.email)

  /* With no encryption key on the deploy there is nowhere safe to put a
     credential, so the panel is told that rather than being allowed to offer
     a form whose submission would be refused. Same reasoning as the mailer
     block on /api/health: a half-configured feature that reports itself ready
     is the failure worth designing against. */
  const configured = integrationsConfigured()

  let rows: ReturnType<typeof publicRow>[] = []
  if (configured) {
    try {
      rows = (await listIntegrations(caller.identityUserId, caller.email)).map(publicRow)
    } catch {
      return fail('Could not read your integrations. Please try again.', 500)
    }
  }

  return json({
    ok: true,
    signedIn: true,
    entitled,
    configured,
    platforms: publicCatalogue(),
    integrations: rows
  })
}
