/* ==========================================================================
   Scheduled: reconcile MEXC deposits against open orders.

   Runs every two minutes on published deploys. The customer's checkout page
   also nudges a single-coin pass while it is open, so in practice a payment
   is usually credited within seconds of MEXC seeing it; this schedule is the
   guarantee underneath that — it catches the customer who closed the tab, the
   one whose transfer took an hour, and every payment that arrived while the
   site was getting no traffic at all.

   The window it asks for is a rolling seven days rather than "everything
   since my last run", which is what makes an outage self-healing: a poller
   that was down all weekend, or a key that expired on a Friday, catches up
   completely on its next successful run. Deduplication is the unique
   constraint on deposits.tx_id, not the query.
   ========================================================================== */

import type { Config } from '@netlify/functions'
import { pollableCoins } from '../lib/assets.mjs'
import { runPoll } from '../lib/poller.mjs'

export default async () => {
  /* alert: true only here. The nudge from /api/subscription runs the same pass
     on a customer's page load, and letting it raise alerts would mean a single
     bad minute paging the operator once per visitor. This runs on a schedule
     nobody can influence, which is what makes it the right place to shout
     from. Alerts are no-ops until a channel is configured. */
  const result = await runPoll(pollableCoins(), { alert: true })

  /* Logged rather than returned — scheduled functions have no response body
     to read. These lines are what a deploy log gets searched for when someone
     asks why a payment has not landed. */
  console.log(
    `[mexc-poll] coins=${result.coins.join(',')} seen=${result.seen} credited=${result.credited} confirming=${result.confirming} review=${result.review}`
  )

  for (const failure of result.failures) {
    /* Deliberately loud. A key that has lapsed produces no errors anywhere
       else on the site — the checkout still works, the payment still arrives,
       and nothing is ever credited. This log line and /api/health are the
       only two places that silence becomes visible. */
    console.error(
      `[mexc-poll] ${failure.coin} failed${failure.authish ? ' (credential problem — renew the MEXC API key)' : ''}: ${failure.message}`
    )
  }
}

export const config: Config = {
  schedule: '*/2 * * * *'
}
