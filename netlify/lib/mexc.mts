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

/* Signed GET. MEXC signs the raw query string with HMAC-SHA256 and expects
   the key in a header, so the secret itself is never transmitted. */
async function signedGet(path: string, params: Record<string, string>) {
  const { key, secret } = credentials()

  const query = new URLSearchParams({ ...params, timestamp: String(Date.now()) })
  const signature = createHmac('sha256', secret).update(query.toString()).digest('hex')
  query.set('signature', signature)

  const res = await fetch(`${BASE}${path}?${query.toString()}`, {
    headers: { 'X-MEXC-APIKEY': key }
  })

  if (!res.ok) throw await readError(res)
  return res.json()
}

/* GET /api/v3/capital/deposit/hisrec

   Deliberately queried as a rolling window rather than "everything since my
   last successful poll". MEXC keeps 7 days by default, so a poller that has
   been down for a few hours — or a key that lapsed over a weekend — catches
   up on its next run instead of leaving a permanent hole. Deduplication is
   the unique constraint on deposits.tx_id, not the query. */
export async function depositHistory(coin: string, windowDays = 7): Promise<MexcDeposit[]> {
  const endTime = Date.now()
  const startTime = endTime - windowDays * 24 * 60 * 60 * 1000

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
  const res = await fetch(`${BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`)
  if (!res.ok) throw await readError(res)

  const body = (await res.json()) as { price?: string }
  const price = Number(body?.price)

  if (!isFinite(price) || price <= 0) {
    throw new MexcError(`MEXC returned an unusable price for ${symbol}`, 502, null)
  }

  return price
}
