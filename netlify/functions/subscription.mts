/* ==========================================================================
   GET /api/subscription — who is signed in, and what have they paid for.

   The one authoritative answer to the question the whole site turns on.
   localStorage['cs-account'] still exists, but from here on it is a cache
   that keeps the pre-paint stamp from flashing the wrong state; this endpoint
   is what decides. A hand-edited browser store can no longer unlock anything,
   because js/account.js overwrites it with whatever this says.

   The three states are the ones the markup already speaks:
     none    — no order, an order opened and not yet declared, or a term
               that has run out
     pending — payment declared, waiting on MEXC to credit it
     active  — credited, and the term it bought has not ended yet

   Responds with:
     { ok: true, signedIn: boolean, status: 'none'|'pending'|'active', … }
   ========================================================================== */

import { getUser } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { json } from '../lib/http.mjs'
import { assetById } from '../lib/assets.mjs'
import { quote } from '../lib/pricing.mjs'
import { nudge } from '../lib/poller.mjs'
import {
  TERM_GRACE_MS,
  findOpenOrderForUser,
  findOrderByReference,
  findPaidOrderForUser,
  isInTerm,
  termEndsAt,
  type OrderRow
} from '../lib/store.mjs'

/* Two lookups rather than one, because a customer renewing an active plan has
   both at once: a term still running and a transfer still in flight. The
   single query this replaced had to rank one above the other, which is how a
   renewing customer got handed their old paid order and was bounced out of
   the checkout before they could pay for the new one. */

/* An order sitting at 'awaiting' is a reserved amount, not a claim on
   anything — the customer opened the checkout and may never come back. It
   reads as 'none' so the workspace keeps offering the plan picker, but the
   order still rides along in the response so the checkout can resume it. */
function uiStatus(paid: OrderRow | null, openOrder: OrderRow | null) {
  if (isInTerm(paid)) return 'active'
  if (openOrder && openOrder.status === 'confirming') return 'pending'
  return 'none'
}

function orderPayload(order: OrderRow) {
  const asset = assetById(order.asset_id)

  return {
    reference: order.reference,
    state: order.status,
    plan: order.plan,
    months: String(order.months),
    amountUsd: Number(order.amount_usd),
    assetId: order.asset_id,
    sym: asset?.sym ?? order.coin,
    coin: order.coin,
    network: order.network,
    address: order.address,
    amount: order.expected_amount,
    rate: Number(order.locked_rate),
    expiresAt: new Date(order.rate_expires_at).getTime(),
    txHash: order.tx_hash,
    paidAt: order.paid_at ? new Date(order.paid_at).getTime() : null,
    termEndsAt: termEndsAt(order)
  }
}

/* The checkout names the order it is watching. Without this the endpoint has
   to guess, and it guesses wrong in a case that happens on the way to every
   payment: a customer who picks BTC, changes their mind and pays in USDT has
   two open orders, and "the newest open order" is not necessarily the one on
   their screen. Ownership is checked, so a reference is a lookup key and not
   a way to read somebody else's order. */
async function focusOrder(reference: string, userId: string, email: string) {
  if (!reference) return null
  const order = await findOrderByReference(reference)
  if (!order) return null
  if (order.identity_user_id === userId || order.email === email) return order
  return null
}

export default async (req: Request, _context: Context) => {
  const user = await getUser()

  if (!user) {
    return json({ ok: true, signedIn: false, status: 'none', subscription: null, order: null })
  }

  const email = String(user.email || '')

  const wanted = (new URL(req.url).searchParams.get('reference') || '').trim().toUpperCase()

  let paid = await findPaidOrderForUser(user.id, email)
  let openOrder = await findOpenOrderForUser(user.id, email)
  let focus = await focusOrder(wanted, user.id, email)

  /* A customer with an open order is very likely sitting on the checkout page
     right now, watching. Rather than make them wait for the next scheduled
     pass, ask MEXC about their coin directly — throttled to one call every
     twenty seconds per coin, so a page polling every few seconds costs almost
     nothing. The schedule remains the guarantee; this is only what makes the
     good case feel immediate.

     'awaiting' is included deliberately. Plenty of people send the transfer
     and never click the button that declares it, and the amount identifies
     them either way — so their payment should confirm just as fast. */
  const watching = focus && focus.status !== 'paid' ? focus : openOrder

  if (watching) {
    const nudged = await nudge(watching.coin)
    if (nudged && (nudged.credited > 0 || nudged.confirming > 0)) {
      paid = await findPaidOrderForUser(user.id, email)
      openOrder = await findOpenOrderForUser(user.id, email)
      focus = await focusOrder(wanted, user.id, email)
    }
  }

  const status = uiStatus(paid, openOrder)

  /* Which order the workspace is describing. An active plan is described by
     the order that paid for it; a pending one by the transfer in flight. */
  const basis = status === 'active' ? paid : status === 'pending' ? openOrder : null

  /* Shaped like the record js/account.js already stores, so reconciliation is
     an assignment rather than a translation. */
  const subscription = basis
    ? {
        plan: basis.plan,
        months: String(basis.months),
        status,
        reference: basis.reference,
        started: new Date(basis.created_at).getTime(),
        planName: quote(basis.plan, basis.months).plan.name,
        termEndsAt: termEndsAt(basis)
      }
    : null

  /* A term that has run out, reported separately from the status it produces.
     The status is 'none', which is correct — the tools lock and the picker
     comes back — but "you had a Professional plan and it ended on the 4th" is
     a different thing to say than "you have never had a plan", and only one of
     them tells the customer what to do about it. */
  const lapsed =
    paid && !isInTerm(paid)
      ? {
          plan: paid.plan,
          planName: quote(paid.plan, paid.months).plan.name,
          months: String(paid.months),
          reference: paid.reference,
          termEndsAt: termEndsAt(paid),
          graceEndsAt: (termEndsAt(paid) ?? 0) + TERM_GRACE_MS
        }
      : null

  /* The order the caller asked about, then the open one, then the paid one:
     the checkout needs the transfer it is watching, not the plan that is
     already paid for. */
  const current = focus || openOrder || paid

  return json({
    ok: true,
    signedIn: true,
    verified: Boolean(user.confirmedAt),
    email,
    name: user.name || String(user.userMetadata?.full_name || ''),
    status,
    subscription,
    lapsed,
    order: current ? orderPayload(current) : null
  })
}
