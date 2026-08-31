/* ==========================================================================
   Order and deposit persistence.

   Everything money-related lives here so the endpoints stay thin and the
   invariants are in one place:

     · an order's expected amount is unique among open orders, which is what
       makes an incoming deposit attributable to exactly one customer;
     · a transaction hash can pay for at most one order, enforced by a unique
       constraint rather than by application logic;
     · every deposit MEXC reports is recorded whether or not it matches, so an
       unattributable payment is a review item and never a lost one.
   ========================================================================== */

import { getDatabase } from '@netlify/database'
import { assetById, type PayAsset } from './assets.mjs'
import { quote } from './pricing.mjs'

/* The rate lock, not the order, is what expires. */
export const RATE_WINDOW_MS = 30 * 60 * 1000

/* How long a lapsed term keeps working. Renewal is a manual crypto transfer,
   not a card on file, so the customer has to notice the term ended, choose a
   term, open a wallet and wait for confirmations. Cutting a paying customer's
   workspace off at the stroke of the term end would punish them for that. */
export const TERM_GRACE_MS = 3 * 24 * 60 * 60 * 1000

const OPEN_STATUSES = ['awaiting', 'confirming']

export interface OrderRow {
  id: number
  reference: string
  identity_user_id: string | null
  email: string
  plan: string
  months: number
  amount_usd: string
  asset_id: string
  coin: string
  network: string
  address: string
  expected_amount: string
  locked_rate: string
  status: string
  tx_hash: string | null
  deposit_network: string | null
  confirmations: string | null
  rate_expires_at: string
  paid_at: string | null
  /* When the term this order bought runs out. Written once, at the moment the
     deposit is credited, and never touched again. */
  term_ends_at: string | null
  receipt_sent_at: string | null
  created_at: string
}

function db() {
  return getDatabase()
}

/* ---------- Reference ---------------------------------------------------- */

function makeReference() {
  const stamp = Date.now().toString(36).toUpperCase().slice(-4)
  const rand = Math.floor(Math.random() * 1296)
    .toString(36)
    .toUpperCase()
    .padStart(2, '0')
  return `CS-${stamp}${rand}`
}

/* ---------- Transaction hashes ------------------------------------------- */

/* One transfer has one identity, but not one spelling: a customer pastes an
   EVM hash with the 0x prefix and in mixed case, MEXC reports it in its own
   form, and a block explorer gives a third. Everything that touches
   orders.tx_hash goes through here first, so the unique constraint on that
   column is actually a constraint on the transfer rather than on the text. */
export function normalizeTxId(value: string) {
  const trimmed = String(value || '').trim().toLowerCase()
  return trimmed.slice(0, 2) === '0x' ? trimmed.slice(2) : trimmed
}

/* ---------- Amount arithmetic -------------------------------------------- */

/* Amounts are handled in the asset's smallest displayed unit as integers.
   Doing the arithmetic in floats and rounding at the end is how a quote and
   an on-chain transfer end up one satoshi apart and stop matching. */
function toUnits(usdTotal: number, rate: number, dec: number) {
  return BigInt(Math.ceil((usdTotal / rate) * Math.pow(10, dec)))
}

function unitsToDecimal(units: bigint, dec: number) {
  if (dec === 0) return units.toString()
  const s = units.toString().padStart(dec + 1, '0')
  return `${s.slice(0, s.length - dec)}.${s.slice(s.length - dec)}`
}

/* The jitter. A customer is quoted 350.37 rather than 350.00 so that the
   amount alone identifies their order — MEXC hands out one deposit address per
   coin and network, shared across every customer, so the address cannot do it
   and a transaction hash requires the customer to paste one. The tail is at
   most 99 of the asset's smallest displayed unit: a cent on USDT, invisible on
   BTC, and never below the quoted price. */
const JITTER_RANGE = 99

/* ---------- Orders ------------------------------------------------------- */

export interface CreateOrderInput {
  identityUserId: string | null
  email: string
  planId: string
  months: number
  asset: PayAsset
  rate: number
}

/* Inserts an order, retrying on the unique index that keeps two open orders
   from quoting the same coin and amount. The retry is the whole reason the
   constraint is in the database rather than in a SELECT-then-INSERT check:
   two customers can reach this line at the same instant. */
export async function createOrder(input: CreateOrderInput): Promise<OrderRow> {
  const q = quote(input.planId, input.months)
  const base = toUnits(q.total, input.rate, input.asset.dec)
  const expiresAt = new Date(Date.now() + RATE_WINDOW_MS).toISOString()

  const tried: number[] = []

  for (let attempt = 0; attempt < 30; attempt += 1) {
    let jitter = 1 + Math.floor(Math.random() * JITTER_RANGE)
    while (tried.indexOf(jitter) !== -1 && tried.length < JITTER_RANGE) {
      jitter = 1 + Math.floor(Math.random() * JITTER_RANGE)
    }
    tried.push(jitter)

    const amount = unitsToDecimal(base + BigInt(jitter), input.asset.dec)
    const reference = makeReference()

    try {
      const rows = (await db().sql`
        INSERT INTO orders (
          reference, identity_user_id, email, plan, months, amount_usd,
          asset_id, coin, network, address,
          expected_amount, locked_rate, status, rate_expires_at
        ) VALUES (
          ${reference}, ${input.identityUserId}, ${input.email}, ${q.planId},
          ${q.months}, ${q.total.toFixed(2)},
          ${input.asset.id}, ${input.asset.coin}, ${input.asset.network},
          ${input.asset.address},
          ${amount}, ${String(input.rate)}, 'awaiting', ${expiresAt}
        )
        RETURNING *
      `) as unknown as OrderRow[]

      return rows[0]
    } catch (error) {
      /* 23505 is a unique violation. On the amount index that means another
         open order already quotes this exact figure, so try a new tail. On
         the reference index it means a once-in-a-blue-moon collision, and the
         same retry covers it. */
      const code = (error as { code?: string })?.code
      if (code === '23505') continue
      throw error
    }
  }

  throw new Error('Could not allocate a unique payment amount for this order.')
}

export async function findOrderByReference(reference: string) {
  const rows = (await db().sql`
    SELECT * FROM orders WHERE reference = ${reference} LIMIT 1
  `) as unknown as OrderRow[]
  return rows[0] || null
}

/* ---------- Terms -------------------------------------------------------- */

/* When an order's term ends, in epoch milliseconds. term_ends_at is the
   answer for anything credited since that column existed; the fallback covers
   a row the migration could not date, and returns null rather than guessing
   for an order that was never paid at all. */
export function termEndsAt(order: OrderRow | null): number | null {
  if (!order || order.status !== 'paid') return null
  if (order.term_ends_at) return new Date(order.term_ends_at).getTime()
  if (!order.paid_at) return null
  const start = new Date(order.paid_at)
  const end = new Date(start)
  end.setMonth(end.getMonth() + Number(order.months || 0))
  return end.getTime()
}

/* Whether the plan this order bought is still one the workspace should honour,
   grace period included. An order with no determinable end is treated as
   current: the failure this site cannot afford is locking out someone who
   paid, and there is no such thing here as a paid order that never began. */
export function isInTerm(order: OrderRow | null, now = Date.now()) {
  if (!order || order.status !== 'paid') return false
  const end = termEndsAt(order)
  if (end === null) return true
  return now < end + TERM_GRACE_MS
}

/* The paid order that carries the furthest-reaching term. Ordered by the term
   end rather than by created_at because renewals chain: the newest order is
   usually the one that reaches furthest, but a customer who bought a month
   after buying a year is not back to a month. */
export async function findPaidOrderForUser(identityUserId: string | null, email: string) {
  const rows = (await db().sql`
    SELECT * FROM orders
     WHERE (identity_user_id = ${identityUserId} OR email = ${email})
       AND status = 'paid'
     ORDER BY COALESCE(term_ends_at, paid_at, created_at) DESC,
              created_at DESC
     LIMIT 1
  `) as unknown as OrderRow[]
  return rows[0] || null
}

/* The order still waiting on money — what the checkout is looking at, and the
   coin the nudge should ask MEXC about. Kept separate from the paid lookup so
   a customer renewing an active plan has both at once: a live term and a
   transfer in flight. Conflating the two is what used to bounce a renewing
   customer out of the checkout before they could pay. */
export async function findOpenOrderForUser(identityUserId: string | null, email: string) {
  const rows = (await db().sql`
    SELECT * FROM orders
     WHERE (identity_user_id = ${identityUserId} OR email = ${email})
       AND status IN ('confirming', 'awaiting')
     ORDER BY CASE status WHEN 'confirming' THEN 0 ELSE 1 END,
              created_at DESC
     LIMIT 1
  `) as unknown as OrderRow[]
  return rows[0] || null
}

/* The open order to hand back when a customer reloads the checkout or picks
   the same asset twice. Without this, every refresh would mint a new order
   and a new amount, filling up the jitter space and leaving a trail of
   never-to-be-paid rows for the poller to consider. */
export async function findReusableOrder(
  identityUserId: string | null,
  email: string,
  assetId: string,
  planId: string,
  months: number
) {
  const rows = (await db().sql`
    SELECT * FROM orders
     WHERE (identity_user_id = ${identityUserId} OR email = ${email})
       AND asset_id = ${assetId}
       AND plan = ${planId}
       AND months = ${months}
       AND status = 'awaiting'
       AND tx_hash IS NULL
       AND rate_expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1
  `) as unknown as OrderRow[]
  return rows[0] || null
}

/* A cheap ceiling on how many unpaid amounts one account can reserve. Six
   assets times a couple of terms is the honest maximum; well past that is
   either a stuck page or someone probing. */
export async function countOpenOrdersForUser(identityUserId: string | null, email: string) {
  const rows = (await db().sql`
    SELECT COUNT(*)::int AS n FROM orders
     WHERE (identity_user_id = ${identityUserId} OR email = ${email})
       AND status = ANY(${OPEN_STATUSES})
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

/* Records the hash a customer pasted. Not a settlement — the poller still has
   to see the deposit credited on MEXC before anything unlocks. The unique
   constraint on tx_hash is what stops one real transfer, pasted by several
   people, from paying for several orders. */
export async function claimTransaction(reference: string, txHash: string) {
  const hash = normalizeTxId(txHash)

  try {
    const rows = (await db().sql`
      UPDATE orders
         SET tx_hash = ${hash},
             status = CASE WHEN status = 'awaiting' THEN 'confirming' ELSE status END,
             updated_at = NOW()
       WHERE reference = ${reference}
         AND status IN ('awaiting', 'confirming')
      RETURNING *
    `) as unknown as OrderRow[]
    return { ok: true as const, order: rows[0] || null }
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') {
      return { ok: false as const, reason: 'duplicate' as const }
    }
    throw error
  }
}

/* The "I have sent the payment" button. A declaration, not a settlement —
   it moves the order out of "awaiting" so the checkout and the workspace can
   say something truthful while the poller waits for MEXC to credit it. */
export async function declareSent(reference: string) {
  const rows = (await db().sql`
    UPDATE orders
       SET status = 'confirming', updated_at = NOW()
     WHERE reference = ${reference}
       AND status = 'awaiting'
    RETURNING *
  `) as unknown as OrderRow[]
  return rows[0] || null
}

/* Crediting an order is also the moment its term gets dated, and the date is
   chained rather than started fresh: a customer who renews three weeks early
   has their new term begin where the old one ends, not today. GREATEST against
   NOW() handles the other direction — a term that already lapsed cannot hand
   backdated time to its replacement.

   Returns the row so the caller can act on what it just wrote (the receipt
   email needs the reference, the amount and the new term end). COALESCE on
   term_ends_at makes a second pass over an already-paid order inert. */
export async function markOrderPaid(
  orderId: number,
  info: { txId: string; network: string | null; confirmations: string | null }
) {
  const rows = (await db().sql`
    UPDATE orders AS o
       SET status = 'paid',
           paid_at = COALESCE(o.paid_at, NOW()),
           tx_hash = COALESCE(o.tx_hash, ${normalizeTxId(info.txId)}),
           deposit_network = ${info.network},
           confirmations = ${info.confirmations},
           term_ends_at = COALESCE(
             o.term_ends_at,
             GREATEST(
               NOW(),
               COALESCE(
                 (SELECT MAX(prior.term_ends_at)
                    FROM orders AS prior
                   WHERE prior.id <> o.id
                     AND prior.status = 'paid'
                     AND (prior.identity_user_id = o.identity_user_id
                          OR prior.email = o.email)),
                 NOW()
               )
             ) + ((o.months)::text || ' months')::interval
           ),
           updated_at = NOW()
     WHERE o.id = ${orderId}
     RETURNING *
  `) as unknown as OrderRow[]

  return rows[0] || null
}

/* ---------- Receipts ----------------------------------------------------- */

/* Claim the right to send one order's receipt. The UPDATE is the lock: two
   pollers racing on the same credited order both run this, and exactly one
   gets a row back. Whoever loses does nothing, which is the correct outcome —
   a duplicate receipt reads as a duplicate charge. */
export async function claimReceipt(orderId: number) {
  const rows = (await db().sql`
    UPDATE orders
       SET receipt_sent_at = NOW()
     WHERE id = ${orderId}
       AND receipt_sent_at IS NULL
     RETURNING id
  `) as unknown as { id: number }[]

  return rows.length > 0
}

/* Hand the claim back when the send actually failed, so the next pass tries
   again instead of the receipt being lost to an optimistic timestamp. */
export async function releaseReceipt(orderId: number) {
  await db().sql`
    UPDATE orders SET receipt_sent_at = NULL WHERE id = ${orderId}
  `
}

export async function markOrderConfirming(
  orderId: number,
  info: { txId: string; network: string | null; confirmations: string | null }
) {
  await db().sql`
    UPDATE orders
       SET status = 'confirming',
           tx_hash = COALESCE(tx_hash, ${normalizeTxId(info.txId)}),
           deposit_network = ${info.network},
           confirmations = ${info.confirmations},
           updated_at = NOW()
     WHERE id = ${orderId}
       AND status = 'awaiting'
  `
}

/* ---------- Matching ----------------------------------------------------- */

/* An order whose hash the customer already declared. Strongest signal there
   is: they told us which transfer is theirs before it landed. */
export async function findOrderByTxHash(txId: string) {
  const rows = (await db().sql`
    SELECT * FROM orders WHERE tx_hash = ${normalizeTxId(txId)} LIMIT 1
  `) as unknown as OrderRow[]
  return rows[0] || null
}

/* Exact amount match against an open order. Exact on purpose: the jitter
   exists precisely so that "close enough" never has to be guessed at. A
   deposit that does not match to the unit goes to the review queue with the
   money safely in the account, which is the right failure. */
export async function findOpenOrderByAmount(coin: string, amount: string) {
  const rows = (await db().sql`
    SELECT * FROM orders
     WHERE coin = ${coin}
       AND status = ANY(${OPEN_STATUSES})
       AND expected_amount = ${amount}::numeric
     ORDER BY created_at ASC
     LIMIT 1
  `) as unknown as OrderRow[]
  return rows[0] || null
}

/* ---------- Deposits ----------------------------------------------------- */

export interface DepositInput {
  txId: string
  coin: string
  network: string | null
  amount: string
  address: string | null
  status: number | null
  confirmTimes: string | null
  unlockConfirm: string | null
  insertTime: number | null
}

/* Upsert keyed on tx_id, which is what makes re-polling a rolling seven-day
   window free of side effects. */
export async function recordDeposit(
  deposit: DepositInput,
  matchedOrderId: number | null,
  reviewReason: string | null
) {
  const insertTime = deposit.insertTime ? new Date(deposit.insertTime).toISOString() : null

  await db().sql`
    INSERT INTO deposits (
      tx_id, coin, network, amount, address, mexc_status,
      confirm_times, unlock_confirm, insert_time, matched_order_id, review_reason
    ) VALUES (
      ${deposit.txId}, ${deposit.coin}, ${deposit.network}, ${deposit.amount},
      ${deposit.address}, ${deposit.status}, ${deposit.confirmTimes},
      ${deposit.unlockConfirm}, ${insertTime}, ${matchedOrderId}, ${reviewReason}
    )
    ON CONFLICT (tx_id) DO UPDATE SET
      mexc_status = EXCLUDED.mexc_status,
      network = EXCLUDED.network,
      confirm_times = EXCLUDED.confirm_times,
      unlock_confirm = EXCLUDED.unlock_confirm,
      matched_order_id = COALESCE(deposits.matched_order_id, EXCLUDED.matched_order_id),
      review_reason = EXCLUDED.review_reason,
      updated_at = NOW()
  `
}

export async function countDepositsNeedingReview() {
  const rows = (await db().sql`
    SELECT COUNT(*)::int AS n FROM deposits WHERE review_reason IS NOT NULL
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

/* The review queue itself, for /api/health?detail=1. A count says something is
   wrong; these rows say what, which is the difference between knowing to look
   and knowing which transfer to go and find. Deliberately no customer data —
   an unmatched deposit has no customer, that being the problem. */
export async function listDepositsNeedingReview(limit = 25) {
  const rows = (await db().sql`
    SELECT tx_id, coin, network, amount, mexc_status, review_reason,
           first_seen_at, matched_order_id
      FROM deposits
     WHERE review_reason IS NOT NULL
     ORDER BY first_seen_at DESC
     LIMIT ${limit}
  `) as unknown as Record<string, unknown>[]
  return rows
}

/* ---------- Operational state ------------------------------------------- */

export async function saveState(key: string, value: Record<string, unknown>) {
  await db().sql`
    INSERT INTO system_state (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `
}

export async function readState(key: string) {
  const rows = (await db().sql`
    SELECT value, updated_at FROM system_state WHERE key = ${key} LIMIT 1
  `) as unknown as { value: Record<string, unknown>; updated_at: string }[]
  return rows[0] || null
}

/* Convenience for the endpoints that need the asset a stored order was
   quoted in. */
export function orderAsset(order: OrderRow) {
  return assetById(order.asset_id)
}
