/* ==========================================================================
   POST /api/order — reserve a payment.

   This is the endpoint that makes a crypto payment on this site attributable.
   Before it existed the checkout invented its own reference in the browser and
   told nobody, which is why a transfer could arrive in the MEXC account with
   no way to say whose it was.

   What it does:
     · reads the plan and term from the pricing model on the server, never
       from the request — the client sends an asset and a plan id, not a price;
     · locks a live rate from MEXC's public ticker (USDT is 1:1 by definition);
     · reserves an amount whose last digits are unique among open orders, so
       the amount alone identifies the payer on a shared deposit address.

   Responds with:
     { ok: true,  order: { … } }
     { ok: false, error: string, code?: string }
   ========================================================================== */

import { getUser, verifyRequestOrigin } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { fail, json, readBody } from '../lib/http.mjs'
import { assetById } from '../lib/assets.mjs'
import { isKnownPlan, isKnownTerm, quote } from '../lib/pricing.mjs'
import { MexcError, MexcNotConfiguredError, spotPrice } from '../lib/mexc.mjs'
import {
  countOpenOrdersForUser,
  createOrder,
  findReusableOrder,
  type OrderRow
} from '../lib/store.mjs'

/* Generous: six assets across a couple of terms is the honest ceiling. */
const MAX_OPEN_ORDERS = 24

function payload(order: OrderRow) {
  const asset = assetById(order.asset_id)
  const q = quote(order.plan, order.months)

  return {
    reference: order.reference,
    status: order.status,
    plan: order.plan,
    planName: q.plan.name,
    months: order.months,
    termLabel: q.termLabel,
    amountUsd: Number(order.amount_usd),
    assetId: order.asset_id,
    assetName: asset?.name ?? order.coin,
    sym: asset?.sym ?? order.coin,
    coin: order.coin,
    network: order.network,
    address: order.address,
    amount: order.expected_amount,
    rate: Number(order.locked_rate),
    conf: asset?.conf ?? '',
    eta: asset?.eta ?? '',
    expiresAt: new Date(order.rate_expires_at).getTime(),
    txHash: order.tx_hash
  }
}

/* USDT is the unit the plans are priced in, so there is no pair to look up
   and nothing to lock. Everything else is quoted against MEXC's own ticker —
   the same venue the deposit lands in, which is what keeps the amount we ask
   for and the amount that gets credited talking about the same number. */
async function rateFor(tickerSymbol: string | null) {
  if (!tickerSymbol) return 1
  return spotPrice(tickerSymbol)
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to reserve a payment.', 405)
  }

  /* Both of these change server state on the strength of a cookie, so the
     Origin has to be checked or another site could drive them from a
     visitor's browser. Same-origin POSTs always carry the header. */
  try {
    verifyRequestOrigin(req)
  } catch {
    return fail('That request did not come from this site.', 403)
  }

  const user = await getUser()
  if (!user) {
    return fail('Sign in to start a payment.', 401, 'signin_required')
  }

  const email = String(user.email || '')
  if (!email) {
    return fail('This account has no email address on file.', 422)
  }

  let body: Record<string, string>
  try {
    body = await readBody(req)
  } catch {
    return fail('That request could not be read.', 400)
  }

  const assetId = String(body.asset || '').trim()
  const planId = String(body.plan || '').trim()
  const months = String(body.months || '').trim()

  const asset = assetById(assetId)
  if (!asset) return fail('Choose one of the payment options.', 422, 'asset')
  if (!isKnownPlan(planId)) return fail('That plan does not exist.', 422, 'plan')
  if (!isKnownTerm(months)) return fail('That billing term does not exist.', 422, 'months')

  const monthsNum = Number(months)

  /* A reload, a second tab or a re-pick of the same asset gets the order it
     already has rather than a fresh amount. */
  const existing = await findReusableOrder(user.id, email, assetId, planId, monthsNum)
  if (existing) {
    return json({ ok: true, order: payload(existing), reused: true })
  }

  if ((await countOpenOrdersForUser(user.id, email)) >= MAX_OPEN_ORDERS) {
    return fail(
      'There are too many unpaid payment requests on this account. Email Cloakshield.pro@outlook.com and we will clear them.',
      429,
      'too_many_open'
    )
  }

  let rate: number
  try {
    rate = await rateFor(asset.tickerSymbol)
  } catch (error) {
    if (error instanceof MexcNotConfiguredError || error instanceof MexcError) {
      /* No rate means no honest amount to ask for. Refusing is the correct
         answer — inventing one would quote a figure the poller could never
         reconcile. */
      return fail(
        `Live ${asset.sym} pricing is unavailable right now. Try again in a moment, or pay in USDT.`,
        503,
        'rate_unavailable'
      )
    }
    throw error
  }

  /* MEXC credits nothing below its own per-coin minimum: a transfer under it
     arrives, is swallowed, and never appears in deposit history at all — so it
     could never be matched to an order or refunded. No plan on this site is
     anywhere near any of those floors, which is exactly why this check is
     worth having: the only way to trip it is a rate that is wrong by orders of
     magnitude, and catching that here means refusing to quote rather than
     quoting a figure that cannot be paid. */
  const estimate = quote(planId, monthsNum).total / rate
  if (!isFinite(estimate) || estimate < asset.minDeposit) {
    return fail(
      `The live ${asset.sym} rate is not usable right now. Pay in USDT, or try again in a few minutes.`,
      422,
      'below_minimum'
    )
  }

  try {
    const order = await createOrder({
      identityUserId: user.id,
      email,
      planId,
      months: monthsNum,
      asset,
      rate
    })

    return json({ ok: true, order: payload(order) })
  } catch {
    return fail('Could not reserve a payment amount. Please try again.', 500)
  }
}
