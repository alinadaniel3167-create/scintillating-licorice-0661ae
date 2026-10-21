/* ==========================================================================
   POST /api/claim — the customer declares, and this settles.

   This endpoint used to record a declaration and nothing more: the order moved
   to "confirming" and only the deposit poller could ever write 'paid', after
   MEXC reported the funds credited. That is no longer how this site operates.
   By deliberate product decision a submitted transaction hash is treated as
   proof of payment, so this function now does all of it in one call:

     · the transaction hash is REQUIRED. Without one nothing is recorded and
       nothing is confirmed — the request is refused with 'tx_hash_required';
     · with one, the hash is attached to the order and the order is credited
       immediately: status 'paid', term dated and chained by markOrderPaid();
     · the receipt goes out from here, because there is no later pass that
       would send it;
     · /api/subscription therefore answers 'active' on the customer's very next
       request, which is what activates the workspace.

   Two consequences are worth knowing before changing anything here:

     · the hash is not verified against any chain. claim.mts can check the
       shape of the string and nothing else, so a well-formed string from
       anybody with a session credits their own order. Reconciliation against
       MEXC still happens — the deposit poller keeps reading deposit history
       and recording every transfer — but it is now an audit trail rather than
       the gate;
     · the poller remains the path for a customer who sends the money and never
       presses the button. It still credits by amount, so nothing here replaces
       it.

   Responds with:
     { ok: true,  status: 'active', reference: string, hash: true, order: {…} }
     { ok: false, error: string, code?: string }
   ========================================================================== */

import { getUser, verifyRequestOrigin } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { fail, json, readBody } from '../lib/http.mjs'
import { deliverReceipt } from '../lib/poller.mjs'
import { quote } from '../lib/pricing.mjs'
import {
  claimTransaction,
  findOrderByReference,
  markOrderPaid,
  normalizeTxId,
  termEndsAt,
  type OrderRow
} from '../lib/store.mjs'

/* Deliberately shape-only. A BTC or TRON txid is 64 hex characters, an EVM
   hash is the same with an 0x prefix, and a Solana signature is base58 and
   longer. Validating any harder would mean maintaining a per-chain parser,
   and no parser could tell a real transfer from a plausible-looking string
   anyway — which is the trade this endpoint now makes knowingly. */
function looksLikeTxHash(value: string) {
  return /^(0x)?[A-Za-z0-9]{32,120}$/.test(value)
}

/* What the checkout needs to paint the confirmed state and open the
   workspace on the right plan. */
function settledPayload(order: OrderRow) {
  return {
    reference: order.reference,
    state: order.status,
    plan: order.plan,
    months: String(order.months),
    planName: quote(order.plan, order.months).plan.name,
    paidAt: order.paid_at ? new Date(order.paid_at).getTime() : Date.now(),
    termEndsAt: termEndsAt(order)
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to declare a payment.', 405)
  }

  /* This changes server state on the strength of a cookie, so the Origin has
     to be checked or another site could drive it from a visitor's browser.
     Same-origin POSTs always carry the header. */
  try {
    verifyRequestOrigin(req)
  } catch {
    return fail('That request did not come from this site.', 403)
  }

  const user = await getUser()
  if (!user) {
    return fail('Sign in to declare a payment.', 401, 'signin_required')
  }

  let body: Record<string, string>
  try {
    body = await readBody(req)
  } catch {
    return fail('That request could not be read.', 400)
  }

  const reference = String(body.reference || '').trim().toUpperCase()
  const txHash = String(body.tx_hash || '').trim()

  if (!reference) return fail('That payment request is missing its reference.', 422)

  const order = await findOrderByReference(reference)
  if (!order) return fail('No payment request with that reference.', 404)

  /* An order belongs to the account that opened it. Matching on either the
     Identity id or the address covers an order opened before the account had
     a session — the address is the same one Identity confirmed. */
  const owned = order.identity_user_id === user.id || order.email === user.email
  if (!owned) return fail('That payment request belongs to another account.', 403)

  /* Already settled. Checked before the hash is, so reopening a finished
     checkout reports the plan rather than demanding a hash for a payment that
     is done. */
  if (order.status === 'paid') {
    return json({ ok: true, status: 'active', reference, hash: true, order: settledPayload(order) })
  }
  if (order.status === 'cancelled') {
    return fail('That payment request was cancelled. Start a new one.', 409, 'cancelled')
  }

  /* The hash is the whole of the evidence now, so there is nothing to do
     without one. The wording is the one the checkout shows against the
     field. */
  if (!txHash) {
    return fail('Please paste your transaction hash before continuing', 422, 'tx_hash_required')
  }

  if (!looksLikeTxHash(txHash)) {
    return fail('That does not look like a transaction hash.', 422, 'tx_hash')
  }

  /* Attach the hash, unless this order already carries it. A confirmation
     that recorded the hash and then failed before crediting leaves the order
     at 'confirming' with the hash set, and the customer's only move is to
     press the button again — which must settle it rather than be refused as a
     duplicate of itself. */
  let working = order

  if (normalizeTxId(order.tx_hash || '') !== normalizeTxId(txHash)) {
    const result = await claimTransaction(reference, txHash)

    if (!result.ok) {
      /* The unique constraint on tx_hash caught it: this transfer is already
         attached to another order. Almost always a customer pasting the same
         hash against a second checkout, occasionally someone borrowing
         someone else's receipt. */
      return fail(
        'That transaction has already been recorded against a payment. Check the reference on your original checkout page, or email Cloakshield.pro@outlook.com.',
        409,
        'duplicate_hash'
      )
    }

    if (!result.order) {
      return fail('That payment request is no longer open.', 409)
    }

    working = result.order
  }

  /* Credit it. markOrderPaid() dates the term and chains it onto any term the
     customer still has running, and is inert on an order that is already
     paid, so a double click costs nothing. */
  const paid = await markOrderPaid(working.id, {
    txId: txHash,
    network: working.network,
    confirmations: null
  })

  if (!paid) {
    return fail('We could not confirm that payment. Try again in a moment.', 500)
  }

  /* The customer's only artefact of the purchase. Awaited rather than fired
     and forgotten: a function container can be frozen the moment it responds,
     and sendMail() has its own timeout so a stalled provider cannot hold this
     response open indefinitely. A failure here does not fail the payment —
     claimReceipt() is handed back and the poller retries on its next pass over
     the matching deposit. */
  try {
    await deliverReceipt(paid)
  } catch {
    /* Never let a receipt fail a confirmed payment. */
  }

  return json({ ok: true, status: 'active', reference, hash: true, order: settledPayload(paid) })
}
