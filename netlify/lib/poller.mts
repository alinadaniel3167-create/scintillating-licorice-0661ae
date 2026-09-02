/* ==========================================================================
   The reconciliation pass. Reads MEXC's deposit history and decides which
   orders are paid.

   This is the only code on the site that can write status 'paid'. It is kept
   here rather than in the scheduled function so that two callers can share
   it: the every-two-minutes schedule, and a throttled single-coin nudge from
   /api/subscription while a customer is actually sitting on the checkout page
   watching for their payment to land.

   Three rules it does not bend:

     · a deposit is only credited on MEXC status 5 or 12. Anything else is
       either in flight or needs a person, and "probably fine" is not a state
       this site has;
     · every deposit MEXC reports is written down whether or not it matches an
       order, with a reason when it does not. An unattributable payment is a
       row in a review queue, never a payment that quietly did not happen;
     · matching is exact. The per-order amount jitter exists so that no
       fuzzy comparison is ever needed.
   ========================================================================== */

import { assetById, pollableCoins } from './assets.mjs'
import { CREDITED_STATUSES, MexcError, MexcNotConfiguredError, depositHistory } from './mexc.mjs'
import type { MexcDeposit } from './mexc.mjs'
import { alertOps, receiptsReady, sendReceipt } from './notify.mjs'
import { quote } from './pricing.mjs'
import {
  claimReceipt,
  compareAmounts,
  countDepositsNeedingReview,
  expireAbandonedOrders,
  findOpenOrderByAmount,
  findOrderByTxHash,
  markOrderConfirming,
  markOrderPaid,
  readState,
  recordDeposit,
  releaseReceipt,
  saveState,
  termEndsAt,
  type OrderRow
} from './store.mjs'

export const POLL_STATE_KEY = 'mexc-poll'

/* MEXC's terminal failure codes: rejected, refunded, invalid, restricted. A
   deposit in one of these has not arrived and is not going to, so it must
   never move an order forward — it goes to review with the code attached. */
const FAILED_STATUSES = [7, 8, 10, 11]

export interface PollOutcome {
  ok: boolean
  at: number
  coins: string[]
  seen: number
  credited: number
  confirming: number
  review: number
  /* Abandoned reservations whose amount tails were handed back this pass. */
  reclaimed: number
  failures: { coin: string; message: string; authish: boolean }[]
}

/* Statuses a deposit may still act on. 'cancelled' is deliberately absent: an
   order that was closed must never be reopened by a transfer arriving against
   a hash somebody attached to it. */
const CREDITABLE_STATUSES = ['awaiting', 'confirming', 'paid']

function reasonFor(deposit: MexcDeposit, mismatch: string | null = null) {
  if (mismatch) return mismatch
  if (deposit.status !== null && FAILED_STATUSES.indexOf(deposit.status) !== -1) {
    return `MEXC reported this deposit as failed (status ${deposit.status})`
  }
  return `No open order expects ${deposit.amount} ${deposit.coin}`
}

/* Why a hash-matched order may NOT be credited by this deposit, or null when
   it may be.

   A transaction hash is the strongest signal about *which* order a transfer
   belongs to, and that is all it is. It says nothing about whether the
   transfer actually paid for it, and the hash is supplied by whoever is
   sitting at the checkout: /api/claim can only check the shape of the string,
   because verifying it would mean a block explorer for each of four chains.

   Without this check the hash bypassed the amount entirely. Reserving the
   $4,800 annual plan, sending a single dollar of USDT to the shared deposit
   address and pasting that transfer's hash was enough to be credited in full —
   and pasting a hash lifted off the address's public on-chain history did the
   same at no cost at all, while also stopping the customer who really sent it
   from ever being matched by amount.

   So the hash attributes and the money still has to be there: same coin, and
   at least the amount the order reserved. Anything else is recorded against
   the order it named and left for a person, with the money safely in the
   account — the same outcome as any other deposit that cannot be explained. */
function hashCorroboration(order: OrderRow, deposit: MexcDeposit): string | null {
  if (CREDITABLE_STATUSES.indexOf(order.status) === -1) {
    return `Transaction ${deposit.txId} names order ${order.reference}, which is ${order.status}`
  }

  if (order.coin !== deposit.coin) {
    return `Transaction ${deposit.txId} names order ${order.reference}, which is payable in ${order.coin}, but the deposit is ${deposit.coin}`
  }

  const cmp = compareAmounts(deposit.amount, order.expected_amount)

  if (cmp === null) {
    return `Transaction ${deposit.txId} names order ${order.reference}, but ${deposit.amount} ${deposit.coin} could not be compared with the ${order.expected_amount} reserved`
  }

  if (cmp < 0) {
    return `Transaction ${deposit.txId} names order ${order.reference}, but ${deposit.amount} ${deposit.coin} does not cover the ${order.expected_amount} ${order.coin} it reserved`
  }

  return null
}

/* The receipt, when there is somewhere to send one from. A crypto payment
   leaves the customer holding a transaction hash and nothing that says what it
   bought, so this is the only artefact of the purchase they get.

   Sent from the nudge as well as the schedule on purpose: somebody sitting on
   the checkout watching their payment land should not wait two minutes for the
   confirmation of a thing they just watched happen. claimReceipt() is what
   makes that safe — the first caller to credit the order wins the send and
   every other caller does nothing. */
async function deliverReceipt(order: OrderRow) {
  if (!receiptsReady()) return
  if (!(await claimReceipt(order.id))) return

  const asset = assetById(order.asset_id)
  const q = quote(order.plan, order.months)

  const sent = await sendReceipt({
    to: order.email,
    reference: order.reference,
    planName: q.plan.name,
    termLabel: q.termLabel,
    amountUsd: Number(order.amount_usd).toFixed(2),
    amountCrypto: order.expected_amount,
    sym: asset?.sym ?? order.coin,
    network: order.deposit_network || order.network,
    txHash: order.tx_hash,
    termEndsAt: termEndsAt(order)
  })

  /* A provider outage must not cost the customer their receipt, so the claim
     goes back and the next pass over this order tries again. */
  if (!sent) await releaseReceipt(order.id)
}

async function reconcile(deposit: MexcDeposit, tally: PollOutcome) {
  tally.seen += 1

  const credited = deposit.status !== null && CREDITED_STATUSES.indexOf(deposit.status) !== -1
  const failed = deposit.status !== null && FAILED_STATUSES.indexOf(deposit.status) !== -1

  /* The hash first: a customer who pasted their transaction told us which
     transfer is theirs, which beats inferring it from the amount — but only
     once the deposit has been checked against what that order actually asked
     for. Then the amount, which is unique among open orders by construction
     and is the attribution scheme this site is built on. */
  const named = await findOrderByTxHash(deposit.txId)
  const mismatch = named ? hashCorroboration(named, deposit) : null
  const byHash = named && !mismatch ? named : null

  const order =
    byHash || (failed ? null : await findOpenOrderByAmount(deposit.coin, deposit.amount))

  if (!order) {
    /* A hash that named an order it cannot pay for is recorded against that
       order anyway: the operator needs to see the two together to work out
       what happened, and matched_order_id is the only thing that links them. */
    tally.review += 1
    await recordDeposit(deposit, named?.id ?? null, reasonFor(deposit, mismatch))
    return
  }

  if (failed) {
    /* Matched, but the money did not arrive. The order stays where it is and
       a human gets told, because the alternative — silently unlocking on a
       refunded deposit — is the one outcome worse than a delay. */
    tally.review += 1
    await recordDeposit(deposit, order.id, reasonFor(deposit))
    return
  }

  const info = {
    txId: deposit.txId,
    network: deposit.network,
    confirmations: deposit.confirmTimes
  }

  if (credited) {
    if (order.status !== 'paid') {
      const paid = await markOrderPaid(order.id, info)
      tally.credited += 1
      if (paid) await deliverReceipt(paid)
    } else if (!order.receipt_sent_at) {
      /* Credited on an earlier pass, but its receipt never left — the provider
         was down, or was not configured yet. The rolling seven-day window
         re-reads this same deposit on every pass, which is what turns that into
         a week of retries rather than one lost email. */
      await deliverReceipt(order)
    }
  } else if (order.status === 'awaiting') {
    await markOrderConfirming(order.id, info)
    tally.confirming += 1
  }

  await recordDeposit(deposit, order.id, null)
}

export interface PollOptions {
  /* Only the scheduled pass raises alerts. The nudge runs on a customer's
     page load — one flaky minute would otherwise page the operator several
     times over, and the schedule two minutes later says the same thing. */
  alert?: boolean
}

/* Poll one coin, or all of them. Failures are collected rather than thrown:
   BTC being unreachable must not stop USDT from being reconciled. */
export async function runPoll(
  coins: string[] = pollableCoins(),
  options: PollOptions = {}
): Promise<PollOutcome> {
  const tally: PollOutcome = {
    ok: true,
    at: Date.now(),
    coins,
    seen: 0,
    credited: 0,
    confirming: 0,
    review: 0,
    reclaimed: 0,
    failures: []
  }

  for (const coin of coins) {
    try {
      const deposits = await depositHistory(coin)

      for (const deposit of deposits) {
        try {
          await reconcile(deposit, tally)
        } catch (error) {
          /* One row that cannot be reconciled must not take the rest of the
             batch with it. Before this, a single failing deposit — a value the
             deposits table will not accept, a lost connection mid-pass —
             aborted the loop, so every deposit after it in the same response
             went unread. The rolling window re-reads the same list every time,
             so a persistent bad row would have blocked the deposits behind it
             on every pass, indefinitely, including paying customers'.

             The run is still marked failed, which keeps it out of
             lastSuccessAt and puts the reason on /api/health. */
          tally.ok = false
          tally.failures.push({
            coin,
            message: `Deposit ${deposit.txId || '(no hash)'} could not be reconciled: ${(error as Error)?.message || 'unknown error'}`,
            authish: false
          })
        }
      }
    } catch (error) {
      tally.ok = false

      if (error instanceof MexcNotConfiguredError) {
        tally.failures.push({
          coin,
          message: 'MEXC credentials are not set on this deploy.',
          authish: true
        })
        continue
      }

      if (error instanceof MexcError) {
        /* The message is MEXC's own text — it names the problem (signature,
           permission, expired key) without ever containing the credential. */
        tally.failures.push({ coin, message: error.message, authish: error.authish })
        continue
      }

      tally.failures.push({
        coin,
        message: (error as Error)?.message || 'Unknown error',
        authish: false
      })
    }
  }

  /* Housekeeping, on full passes only: hand back the amount tails held by
     reservations that can no longer be credited automatically. Wrapped
     separately because it is not part of reconciliation — a failure to tidy up
     must never turn a pass that credited somebody into a failed one. */
  if (tally.coins.length >= pollableCoins().length) {
    try {
      tally.reclaimed = await expireAbandonedOrders()
    } catch {
      /* Next pass. Nothing depends on this having happened. */
    }
  }

  const previous = (await readState(POLL_STATE_KEY))?.value || {}
  await persist(tally, previous as Record<string, unknown>)

  if (options.alert) {
    try {
      await raiseAlerts(tally, previous as Record<string, unknown>)
    } catch {
      /* An alert that could not be sent must never turn a successful
         reconciliation pass into a failed one. */
    }
  }

  return tally
}

/* The record /api/health reads. lastSuccessAt is carried forward across a
   failed run on purpose: "the poller last worked forty minutes ago" is the
   number that matters when a key has quietly expired, and a run that failed
   must not overwrite it. */
async function persist(tally: PollOutcome, previous: Record<string, unknown>) {
  const partial = tally.coins.length < pollableCoins().length

  await saveState(POLL_STATE_KEY, {
    ...previous,
    lastRunAt: tally.at,
    lastRunOk: tally.ok,
    lastRunCoins: tally.coins,
    lastRunPartial: partial,
    lastFailures: tally.failures,
    /* Cleared by any successful pass, including a single-coin nudge: a call
       MEXC answered is proof the key still works, and a stale credential
       warning on /api/health is how a real one gets ignored. */
    lastAuthFailure: tally.failures.some((f) => f.authish)
      ? { at: tally.at, message: tally.failures.find((f) => f.authish)?.message || '' }
      : tally.ok
        ? null
        : (previous.lastAuthFailure ?? null),
    /* A partial nudge that succeeded still proves the credentials work, but
       only a full pass proves nothing is being missed. */
    lastSuccessAt: tally.ok ? tally.at : previous.lastSuccessAt ?? null,
    lastFullSuccessAt:
      tally.ok && !partial ? tally.at : previous.lastFullSuccessAt ?? null,
    totals: {
      seen: tally.seen,
      credited: tally.credited,
      confirming: tally.confirming,
      review: tally.review,
      reclaimed: tally.reclaimed
    }
  })
}

/* ---------- Operator alerts ---------------------------------------------

   /api/health answers the question, but only when somebody asks it. The two
   things worth being woken for are precisely the two the site stays quiet
   about: a MEXC key that has stopped working, and a deposit that arrived and
   could not be attributed to anybody. Both look like nothing at all from the
   outside — the checkout still quotes, the money still lands.

   Alerts are de-duplicated per kind in system_state rather than in memory,
   because each scheduled run is a fresh function instance with no memory of
   the last one. A kind repeats at most every six hours, so a key that expired
   on Friday produces four messages over a weekend rather than seven hundred
   and twenty.
   -------------------------------------------------------------------------- */

const ALERT_STATE_KEY = 'ops-alerts'
const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000

/* Two consecutive misses are a blip; a quarter of an hour is a problem. Matches
   the warn threshold /api/health uses, so the two agree about what "stale"
   means. */
const STALE_ALERT_MS = 15 * 60 * 1000

const HEALTH_HINT = 'Full detail: https://cloakshield.io/api/health?detail=1'

async function raiseAlerts(tally: PollOutcome, previousPoll: Record<string, unknown>) {
  const state = ((await readState(ALERT_STATE_KEY))?.value || {}) as Record<string, unknown>
  const sentAt = { ...((state.sentAt || {}) as Record<string, number>) }
  const now = tally.at

  let openIssue = (state.openIssue as string | null) ?? null
  let dirty = false

  /* Returns whether the message actually left. A send that failed on every
     configured channel is deliberately not recorded, so the next pass tries
     again instead of the throttle hiding an alert nobody ever received. */
  async function fire(kind: string, title: string, lines: string[], force = false) {
    if (!force && now - (sentAt[kind] || 0) < ALERT_REPEAT_MS) return false

    const report = await alertOps({ title, lines, hint: HEALTH_HINT })
    if (!report.configured || report.sent.length === 0) return false

    sentAt[kind] = now
    dirty = true
    return true
  }

  /* 1. The credentials. The ninety-day expiry is the failure this whole
        design worries about most, and it is completely silent. */
  const authFailure = tally.failures.find((f) => f.authish)
  if (authFailure) {
    if (
      await fire('credentials', 'MEXC rejected the API credentials', [
        `MEXC said: ${authFailure.message}`,
        'No deposit can be credited until this is fixed. Payments are still arriving; nothing is unlocking.',
        'Renew the key at MEXC → My API Key → Action → Renew. A renewed key keeps the same value, so the Netlify environment variables do not change.'
      ])
    ) {
      openIssue = 'credentials'
    }
  }

  /* 2. Everything else that stops the pass. Suppressed while a credential
        alert is in flight — one cause, one message. */
  const lastSuccess = Number(previousPoll.lastSuccessAt || 0)
  if (!tally.ok && !authFailure && lastSuccess && now - lastSuccess > STALE_ALERT_MS) {
    const minutes = Math.round((now - lastSuccess) / 60000)
    if (
      await fire('stale', 'The deposit poller is failing', [
        `Nothing has reconciled successfully for ${minutes} minutes.`,
        ...tally.failures.map((f) => `${f.coin}: ${f.message}`)
      ])
    ) {
      openIssue = 'stale'
    }
  }

  /* 3. The review queue. Alerting on an increase rather than on a non-zero
        count is what keeps one unmatched deposit from alerting every six hours
        forever; the mark also moves back down when the queue is cleared, so
        the next one is heard. */
  const review = await countDepositsNeedingReview()
  const known = Number(state.reviewCount || 0)
  let mark = known

  if (review > known) {
    /* The mark only advances when the message actually left. That is what
       makes configuring a channel weeks from now report the backlog that
       accumulated in the meantime, rather than starting from a high-water mark
       nobody was ever told about. */
    if (
      await fire(
        'review',
        `${review} deposit${review === 1 ? '' : 's'} could not be matched to an order`,
        [
          `${review - known} new since the last alert.`,
          'The money is in the MEXC account and recorded, but no open order expects that amount, so nobody has been credited for it.',
          'Match it by hand from the review queue, then set the order to paid.'
        ]
      )
    ) {
      mark = review
    }
  } else if (review < known) {
    /* Cleared, or partly cleared. Moving the mark down is what makes the next
       unmatched deposit heard instead of hiding under an old total. */
    mark = review
  }

  if (mark !== known) dirty = true

  /* 4. Recovery. Worth a message of its own: the operator who was told the
        key had expired needs to know when to stop looking at it. */
  if (tally.ok && openIssue) {
    const told = await fire(
      'recovered',
      'The deposit poller is working again',
      ['A reconciliation pass completed against MEXC, so the credentials are good and anything that was waiting has been credited.'],
      true
    )

    if (told) {
      /* Clear the throttles as well as the flag, so a fresh failure tomorrow
         is heard immediately rather than sitting inside the old six-hour
         window. */
      delete sentAt.credentials
      delete sentAt.stale
      openIssue = null
      dirty = true
    }
  }

  if (dirty) {
    await saveState(ALERT_STATE_KEY, { sentAt, reviewCount: mark, openIssue })
  }
}

/* Throttle for the on-demand nudge. Keyed per coin so a customer paying in
   USDT cannot delay one paying in BTC, and generous enough that a checkout
   page polling every few seconds turns into at most one MEXC call every
   twenty seconds. */
const NUDGE_INTERVAL_MS = 20 * 1000
const nudgedAt: Record<string, number> = {}

export async function nudge(coin: string) {
  const now = Date.now()
  if (now - (nudgedAt[coin] || 0) < NUDGE_INTERVAL_MS) return null
  nudgedAt[coin] = now

  try {
    return await runPoll([coin])
  } catch {
    /* A nudge is a courtesy. The schedule is what guarantees the payment gets
       reconciled, so a failure here must not fail the request that triggered
       it. */
    return null
  }
}
