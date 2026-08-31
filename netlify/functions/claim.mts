/* ==========================================================================
   POST /api/claim — declare that a payment has been sent.

   Two things happen here, and neither of them is a settlement:

     · the order moves from "awaiting" to "confirming", which is what the
       workspace's pending notice reads;
     · if the customer pasted a transaction hash, it is recorded against the
       order so the poller can match on the hash rather than on the amount.

   Nothing in this file, and nothing anywhere in the browser, can mark an
   order paid. Only netlify/functions/mexc-poll.mts does that, and only after
   MEXC reports the deposit as credited.

   Responds with:
     { ok: true,  status: 'pending', reference: string, hash: boolean }
     { ok: false, error: string, code?: string }
   ========================================================================== */

import { getUser, verifyRequestOrigin } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { fail, json, readBody } from '../lib/http.mjs'
import { claimTransaction, declareSent, findOrderByReference } from '../lib/store.mjs'

/* Deliberately shape-only. A BTC or TRON txid is 64 hex characters, an EVM
   hash is the same with an 0x prefix, and a Solana signature is base58 and
   longer. Validating any harder would mean maintaining a per-chain parser to
   reject strings the poller is going to ignore anyway — an unmatched hash
   costs nothing, because the amount still identifies the order. */
function looksLikeTxHash(value: string) {
  return /^(0x)?[A-Za-z0-9]{32,120}$/.test(value)
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return fail('Use POST to declare a payment.', 405)
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

  if (order.status === 'paid') {
    return json({ ok: true, status: 'active', reference, hash: Boolean(order.tx_hash) })
  }
  if (order.status === 'cancelled') {
    return fail('That payment request was cancelled. Start a new one.', 409, 'cancelled')
  }

  if (txHash) {
    if (!looksLikeTxHash(txHash)) {
      return fail('That does not look like a transaction hash.', 422, 'tx_hash')
    }

    const result = await claimTransaction(reference, txHash)

    if (!result.ok) {
      /* The unique constraint on tx_hash caught it: this transfer is already
         attached to an order. Almost always a customer pasting the hash a
         second time on a page they reopened, occasionally someone borrowing
         someone else's receipt. Either way it is not an error the poller
         needs to hear about. */
      return fail(
        'That transaction has already been recorded against a payment. Check the reference on your original checkout page, or email Cloakshield.pro@outlook.com.',
        409,
        'duplicate_hash'
      )
    }

    if (!result.order) {
      return fail('That payment request is no longer open.', 409)
    }

    return json({ ok: true, status: 'pending', reference, hash: true })
  }

  await declareSent(reference)
  return json({ ok: true, status: 'pending', reference, hash: false })
}
