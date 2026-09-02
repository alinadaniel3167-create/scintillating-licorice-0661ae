/* ==========================================================================
   MEXC spot API client — the two calls this site makes.

   Read-only. The key is created with nothing but "View Deposit/Withdrawal
   Details" (SPOT_WITHDRAW_READ) enabled, and both credentials live in Netlify
   environment variables scoped to Functions. Nothing here ever runs in a
   browser: the site's CSP sets connect-src 'self', and a signing secret in
   client JavaScript would hand over the exchange account.

   Keys that are not pinned to an IP allow-list expire after 90 days. Netlify
   Functions egress from a rotating pool, so pinning is not an option — the key
   is renewed from MEXC's own API Management screen instead, and /api/health
   exists so a lapsed one is visible rather than silent.
   ========================================================================== */

import { createHmac } from 'node:crypto'

const BASE = 'https://api.mexc.com'

/* Every call here is made from a function with a hard execution limit, and the
   poller makes one per coin in sequence. A MEXC endpoint that accepts the
   connection and then stalls would otherwise burn the whole budget and return
   nothing — no state written, no failure recorded, nothing on /api/health. A
   request that has not answered in this long has failed; saying so lets the
   remaining coins still reconcile. */
const REQUEST_TIMEOUT_MS = 8000

/* The ticker sits in front of a customer waiting on /api/order, so it gets a
   shorter leash: a stalled quote is better refused quickly than slowly. */
const TICKER_TIMEOUT_MS = 5000

/* Anything non-2xx from MEXC. `authish` marks the subset that most likely
   means the key has lapsed, been revoked or is mis-pasted — the poller words
   its alert differently for those, but alerts either way. */
export class MexcError extends Error {
  status: number
  code: number | null
  authish: boolean

  constructor(message: string, status: number, code: number | null) {
    super(message)
    this.name = 'MexcError'
    this.status = status
    this.code = code
    this.authish =
      status === 401 ||
      status === 403 ||
      /api[\s-]?key|signature|permission|expired|unauthor/i.test(message)
  }
}

export class MexcNotConfiguredError extends Error {
  constructor() {
    super('MEXC_API_KEY / MEXC_API_SECRET are not set on this deploy.')
    this.name = 'MexcNotConfiguredError'
  }
}

export interface MexcDeposit {
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

/* MEXC's deposit status codes. Only these two mean the funds are credited and
   spendable; everything else is either still in flight or needs a human. */
export const CREDITED_STATUSES = [5, 12]

function credentials() {
  const key = process.env.MEXC_API_KEY
  const secret = process.env.MEXC_API_SECRET
  if (!key || !secret) throw new MexcNotConfiguredError()
  return { key, secret }
}

async function readError(res: Response) {
  let code: number | null = null
  let msg = `MEXC responded ${res.status}`

  try {
    const body = (await res.json()) as { code?: number; msg?: string }
    if (typeof body?.code === 'number') code = body.code
    if (body?.msg) msg = body.msg
  } catch {
    /* A non-JSON error body (a gateway page, say) still has to surface. */
  }

  return new MexcError(msg, res.status, code)
}

/* fetch() rejects with an AbortError rather than a MexcError, and an
   unrecognised error type is the one thing the poller reports as "Unknown
   error". Naming the timeout keeps the deploy log and /api/health readable. */
async function timedFetch(url: string, init: RequestInit, timeoutMs: number) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const name = (error as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new MexcError(`MEXC did not respond within ${timeoutMs}ms`, 504, null)
    }
    throw new MexcError(
      `Could not reach MEXC: ${(error as Error)?.message || 'network error'}`,
      502,
      null
    )
  }
}

/* Signed GET. MEXC signs the raw query string with HMAC-SHA256 and expects
   the key in a header, so the secret itself is never transmitted. */
async function signedGet(path: string, params: Record<string, string>) {
  const { key, secret } = credentials()

  const query = new URLSearchParams({ ...params, timestamp: String(Date.now()) })
  const signature = createHmac('sha256', secret).update(query.toString()).digest('hex')
  query.set('signature', signature)

  const res = await timedFetch(
    `${BASE}${path}?${query.toString()}`,
    { headers: { 'X-MEXC-APIKEY': key } },
    REQUEST_TIMEOUT_MS
  )

  if (!res.ok) throw await readError(res)
  return res.json()
}

/* MEXC caps the span between startTime and endTime on deposit history at
   seven days and rejects the whole call when it is exceeded. Asking for
   exactly seven days sat on that boundary: the two timestamps are built from
   the function's clock, MEXC checks them against its own, and a second of skew
   in the wrong direction turns every poll into a 400. The failure would have
   been total and quiet — no deposit credited, and a message that reads as a
   MEXC outage rather than as a bad request — so the window is deliberately a
   little under the cap. Two hours of margin is far more skew than can plausibly
   occur and costs nothing: the poller runs every two minutes, so the overlap
   between consecutive runs is still measured in days. */
export const DEPOSIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 2 * 60 * 60 * 1000

/* GET /api/v3/capital/deposit/hisrec

   Deliberately queried as a rolling window rather than "everything since my
   last successful poll". MEXC keeps seven days, so a poller that has been down
   for a few hours — or a key that lapsed over a weekend — catches up on its
   next run instead of leaving a permanent hole. Deduplication is the unique
   constraint on deposits.tx_id, not the query. */
export async function depositHistory(
  coin: string,
  windowMs = DEPOSIT_WINDOW_MS
): Promise<MexcDeposit[]> {
  const endTime = Date.now()
  const startTime = endTime - Math.min(windowMs, DEPOSIT_WINDOW_MS)

  const raw = (await signedGet('/api/v3/capital/deposit/hisrec', {
    coin,
    startTime: String(startTime),
    endTime: String(endTime),
    limit: '1000'
  })) as Record<string, unknown>[]

  if (!Array.isArray(raw)) return []

  return raw
    .map((row) => ({
      txId: String(row.txId ?? ''),
      coin: String(row.coin ?? coin),
      network: row.network ? String(row.network) : null,
      amount: String(row.amount ?? '0'),
      address: row.address ? String(row.address) : null,
      status: typeof row.status === 'number' ? row.status : Number(row.status ?? NaN) || null,
      confirmTimes: row.confirmTimes ? String(row.confirmTimes) : null,
      unlockConfirm: row.unlockConfirm ? String(row.unlockConfirm) : null,
      insertTime: Number(row.insertTime ?? 0) || null
    }))
    .filter((row) => row.txId !== '')
}

/* GET /api/v3/ticker/price — public, unauthenticated. Replaces the rates that
   used to be hard-coded in checkout.html, which is what makes the 30-minute
   "rate locked" promise true rather than decorative. */
export async function spotPrice(symbol: string): Promise<number> {
  const res = await timedFetch(
    `${BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
    {},
    TICKER_TIMEOUT_MS
  )
  if (!res.ok) throw await readError(res)

  const body = (await res.json()) as { price?: string }
  const price = Number(body?.price)

  if (!isFinite(price) || price <= 0) {
    throw new MexcError(`MEXC returned an unusable price for ${symbol}`, 502, null)
  }

  return price
}
