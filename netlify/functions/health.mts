/* ==========================================================================
   GET /api/health — is payment confirmation actually working?

   The failure mode this exists for is a quiet one. MEXC API keys that are not
   pinned to an IP allow-list expire ninety days after they are created, and
   Netlify Functions egress from a rotating pool of addresses, so pinning is
   not available. When the key lapses, nothing on the customer-facing site
   breaks: the checkout still quotes an amount, the transfer still arrives in
   the account, and no order is ever credited.

   So there is a health check, and what it reports on is staleness rather than
   errors. A poller that has not completed a successful pass in a while is the
   symptom, whatever the cause — expired key, revoked permission, MEXC outage,
   a schedule that stopped firing.

   No credentials, no order data and no customer data are exposed here; it
   answers with timestamps, counts and MEXC's own error text.

   Access. The endpoint stays public while HEALTH_TOKEN is unset, because a
   monitor that has to be reconfigured before it works is a monitor that
   silently stops working — and everything above is operational noise, not
   customer data. Set HEALTH_TOKEN and it starts requiring
   ?token=… or an X-Health-Token header, which is worth doing before using
   ?detail=1: that lists the deposits sitting in review, and while their
   transaction hashes are already public on their own chains, the fact that
   this account cannot account for them is not.
   ========================================================================== */

import type { Context } from '@netlify/functions'
import { fail, json } from '../lib/http.mjs'
import { notificationChannels } from '../lib/notify.mjs'
import { POLL_STATE_KEY } from '../lib/poller.mjs'
import {
  countDepositsNeedingReview,
  listDepositsNeedingReview,
  readState
} from '../lib/store.mjs'

/* The schedule runs every two minutes. Fifteen absorbs a missed run and a
   retry; an hour means something is wrong that a person needs to look at. */
const WARN_AFTER_MS = 15 * 60 * 1000
const FAIL_AFTER_MS = 60 * 60 * 1000

/* Length-independent comparison. The token is a bookmark secret rather than a
   password, but a check that returns early on the first wrong character is
   free to write correctly, so it is. */
function tokenMatches(supplied: string, expected: string) {
  if (supplied.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url)
  const expected = (process.env.HEALTH_TOKEN || '').trim()

  if (expected) {
    const supplied =
      req.headers.get('x-health-token') || url.searchParams.get('token') || ''
    if (!tokenMatches(supplied, expected)) {
      return fail('Not found.', 404)
    }
  }

  const wantDetail = url.searchParams.get('detail') === '1'

  const record = await readState(POLL_STATE_KEY)
  const state = (record?.value || {}) as Record<string, unknown>

  const lastSuccessAt = Number(state.lastSuccessAt || 0) || null
  const lastRunAt = Number(state.lastRunAt || 0) || null
  const age = lastSuccessAt ? Date.now() - lastSuccessAt : null

  let status: 'ok' | 'warn' | 'fail' = 'ok'
  const notes: string[] = []

  if (!lastSuccessAt) {
    status = 'fail'
    notes.push('The deposit poller has never completed a successful run on this deploy.')
  } else if (age !== null && age > FAIL_AFTER_MS) {
    status = 'fail'
    notes.push(
      `The deposit poller last succeeded ${Math.round(age / 60000)} minutes ago. Payments are arriving but nothing is being credited.`
    )
  } else if (age !== null && age > WARN_AFTER_MS) {
    status = 'warn'
    notes.push(`The deposit poller last succeeded ${Math.round(age / 60000)} minutes ago.`)
  }

  if (state.lastAuthFailure) {
    status = 'fail'
    notes.push(
      'MEXC rejected the API credentials. Renew the key from MEXC → API Management → Action → Renew; a renewed key keeps the same value, so the Netlify environment variables do not change.'
    )
  }

  const review = await countDepositsNeedingReview()
  if (review > 0) {
    if (status === 'ok') status = 'warn'
    notes.push(
      `${review} deposit${review === 1 ? '' : 's'} could not be matched to an order and are waiting on a manual check.`
    )
  }

  return json(
    {
      ok: status !== 'fail',
      status,
      poller: {
        lastRunAt,
        lastRunOk: Boolean(state.lastRunOk),
        lastSuccessAt,
        lastFullSuccessAt: Number(state.lastFullSuccessAt || 0) || null,
        minutesSinceSuccess: age === null ? null : Math.round(age / 60000),
        lastFailures: state.lastFailures || [],
        totals: state.totals || null
      },
      depositsNeedingReview: review,
      /* Whether an alert would actually reach anyone. A monitoring endpoint
         that cannot say this is only half a monitoring endpoint: silence looks
         the same whether nothing is wrong or nothing is configured. */
      notifications: notificationChannels(),
      review: wantDetail ? await listDepositsNeedingReview() : undefined,
      notes
    },
    status === 'fail' ? 503 : 200
  )
}
