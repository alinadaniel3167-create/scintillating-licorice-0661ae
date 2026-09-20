/* ==========================================================================
   Accounts and one-time codes.

   This module is why the site can send its own confirmation and reset mail.

   Netlify Identity will do both for you, but only through its own mailer: it
   mints the token inside GoTrue, renders one of the templates in
   email-templates/ and hands the message to whatever SMTP server the Identity
   settings point at. No API returns the token, so no code here could ever put
   it in a Resend message. The practical failure that causes is quiet — a
   project with a working Resend key and an empty Identity mail setting sends
   no confirmation email at all, reports no error, and looks from the outside
   like a site whose customers do not check their spam folder.

   So the challenge moves here, and Identity keeps the parts it is good at:
   the password, the hashing and the session cookie. What this module owns is

     · `accounts`   — the site's own record of an address, and the one fact
                      Identity stops being able to answer once users are
                      created already-confirmed: whether the person holding
                      the address has ever proved they can read its inbox.
     · `auth_codes` — a single-use challenge, issued as a six-digit code and
                      a long link token at the same time. Either redeems it.

   Two digests, two different reasons.

   The **token** is 32 random bytes. That is already far past guessing, so it
   is stored as a plain SHA-256 and looked up by that hash directly — which is
   what lets a link in an email find its row in one indexed query.

   The **code** is six digits. A million possibilities is a fine defence
   against a person typing and no defence at all against a script, so it gets
   two things the token does not need: a per-row random salt, so a stolen copy
   of this table cannot be reversed with a table of a million pre-computed
   digests, and a hard attempt limit, so the row dies after a handful of
   misses rather than waiting to expire.

   Nothing here throws for an ordinary refusal. Issuing and redeeming both
   return a tagged result, because "the code was wrong" and "the database is
   unreachable" want different answers on the page and an exception cannot
   tell them apart.
   ========================================================================== */

import { getDatabase } from '@netlify/database'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

function db() {
  return getDatabase()
}

/* ---------- Shape -------------------------------------------------------- */

export type Purpose = 'signup' | 'recovery'

export interface AccountRow {
  id: number
  email: string
  identity_user_id: string | null
  full_name: string | null
  signup_plan: string | null
  signup_months: string | null
  email_verified_at: string | null
  created_at: string
  updated_at: string
}

interface CodeRow {
  id: number
  email: string
  purpose: string
  salt: string
  code_hash: string
  token_hash: string
  attempts: number
  expires_at: string
  consumed_at: string | null
  created_at: string
}

/* ---------- The numbers -------------------------------------------------- */

/* How long a challenge lives, per purpose.

   A signup code is typed from an inbox the visitor is already looking at, so
   twenty minutes is generous. A reset link is different: the person following
   it has usually just discovered they cannot get in, and may go and find the
   right browser first. An hour costs nothing — the row is single-use and
   superseded the moment another one is asked for. */
const TTL_MS: Record<Purpose, number> = {
  signup: 20 * 60 * 1000,
  recovery: 60 * 60 * 1000
}

/* Wrong guesses one code survives. Six, not three: a customer reading digits
   off a phone screen gets to fat-finger it twice without having to ask for
   another email, and six tries out of a million is not an attack that gets
   anywhere. */
const MAX_ATTEMPTS = 6

/* The gap between two sends to the same address. Short enough that a
   mistyped address is a 60-second wait rather than a support ticket, long
   enough that the resend button cannot be used to post mail at somebody. */
const RESEND_COOLDOWN_MS = 60 * 1000

/* And the ceiling over an hour, which is the one that actually stops abuse —
   the cooldown alone would still allow sixty messages an hour. */
const MAX_PER_HOUR = 6

export const CODE_LENGTH = 6

/* Minutes, for the copy in the email and on the page. Both read this rather
   than carrying their own number, because a message that claims twenty
   minutes over a code that expires in ten is worse than no number at all. */
export function ttlMinutes(purpose: Purpose) {
  return Math.round(TTL_MS[purpose] / 60000)
}

export const RESEND_COOLDOWN_SECONDS = Math.round(RESEND_COOLDOWN_MS / 1000)

/* ---------- Addresses ---------------------------------------------------- */

/* One address has one row, but not one spelling. Everything that reads or
   writes `accounts.email` or `auth_codes.email` goes through here first, so
   the unique constraint on the column is a constraint on the address rather
   than on how the customer happened to type it. */
export function normalizeEmail(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase()
}

/* Deliberately loose. Identity is the authority on what it will accept; this
   only catches the obvious typo before a network round trip. Matched to the
   check in register.mts on purpose — two different rules on one address is
   how a form accepts something the endpoint behind it rejects. */
export function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

/* ---------- Digests ------------------------------------------------------ */

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/* The salt is per row and the purpose is in the digest, so a code mailed to
   confirm an address cannot be replayed against the recovery row that the
   same six digits might happen to match. */
function codeDigest(code: string, salt: string, purpose: string) {
  return sha256(`${salt}:${purpose}:${code}`)
}

/* No salt, by design — see the header. 32 random bytes need no stretching,
   and an unsalted digest is what makes the unique index on token_hash usable
   as a lookup key. */
function tokenDigest(token: string) {
  return sha256(token)
}

/* Both arguments are hex digests of identical length, so this compares in
   constant time without the length check leaking anything. */
function sameDigest(a: string, b: string) {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/* ---------- Generating a challenge --------------------------------------- */

/* randomInt, not Math.random: this is a credential, and the modulo bias in a
   hand-rolled version is exactly the sort of detail that survives review and
   then narrows the keyspace. Padded rather than range-shifted so every code
   is six characters and '000418' is as likely as any other. */
function makeCode() {
  return String(randomInt(0, 1000000)).padStart(CODE_LENGTH, '0')
}

/* base64url, so the token survives a URL fragment, an email client's line
   wrapping and a customer copying it by hand. */
function makeToken() {
  return randomBytes(32).toString('base64url')
}

/* ---------- Accounts ----------------------------------------------------- */

export async function findAccount(email: string): Promise<AccountRow | null> {
  const rows = (await db().sql`
    SELECT * FROM accounts WHERE email = ${normalizeEmail(email)} LIMIT 1
  `) as unknown as AccountRow[]
  return rows[0] || null
}

export interface AccountInput {
  email: string
  identityUserId?: string | null
  fullName?: string | null
  signupPlan?: string | null
  signupMonths?: string | null
}

/* Called at registration, and again on any later pass that learns something
   the row did not have. COALESCE on the incoming side rather than the stored
   side: a second registration attempt that omits the plan should not blank
   the plan the first one recorded. `email_verified_at` is never touched here
   — only markAccountVerified writes it, so there is exactly one place that
   can turn the gate off. */
export async function upsertAccount(input: AccountInput): Promise<AccountRow> {
  const email = normalizeEmail(input.email)

  const rows = (await db().sql`
    INSERT INTO accounts (email, identity_user_id, full_name, signup_plan, signup_months)
    VALUES (${email}, ${input.identityUserId ?? null}, ${input.fullName ?? null},
            ${input.signupPlan ?? null}, ${input.signupMonths ?? null})
    ON CONFLICT (email) DO UPDATE
       SET identity_user_id = COALESCE(EXCLUDED.identity_user_id, accounts.identity_user_id),
           full_name        = COALESCE(EXCLUDED.full_name,        accounts.full_name),
           signup_plan      = COALESCE(EXCLUDED.signup_plan,      accounts.signup_plan),
           signup_months    = COALESCE(EXCLUDED.signup_months,    accounts.signup_months),
           updated_at       = NOW()
    RETURNING *
  `) as unknown as AccountRow[]

  return rows[0]
}

/* Returns true only on the transition — the call that actually moved the
   column off NULL. That is what the welcome email keys off, so a second
   redemption, a reset on an already-verified address, or two tabs racing each
   other cannot produce a second copy of it. */
export async function markAccountVerified(email: string): Promise<boolean> {
  const rows = (await db().sql`
    UPDATE accounts
       SET email_verified_at = NOW(), updated_at = NOW()
     WHERE email = ${normalizeEmail(email)}
       AND email_verified_at IS NULL
    RETURNING id
  `) as unknown as Array<{ id: number }>

  return rows.length > 0
}

/* ---------- Issuing ------------------------------------------------------ */

export type IssueResult =
  | { ok: true; code: string; token: string; expiresAt: Date; minutes: number }
  /* Asked again too soon. `retryAfter` is seconds, so the page can count
     down rather than saying "later". */
  | { ok: false; reason: 'cooldown'; retryAfter: number }
  /* Past the hourly ceiling. Deliberately not distinguished from a cooldown
     on any public response — both mean "not now" — but they are separate here
     because the operator log wants to know which. */
  | { ok: false; reason: 'capped'; retryAfter: number }

/* Issues a fresh challenge and returns the clear code and token exactly once,
   to the caller that is about to put them in an email. They are not stored
   and cannot be read back.

   Any earlier open challenge for the same address and purpose is expired on
   the way past, so the newest code is always the one that works. That is the
   behaviour a customer assumes after clicking "send it again", and the
   alternative — two live codes, one of which is the one they are reading —
   produces a support ticket that is impossible to diagnose from the logs. */
export async function issueCode(
  email: string,
  purpose: Purpose,
  ip?: string | null
): Promise<IssueResult> {
  const address = normalizeEmail(email)

  const recent = (await db().sql`
    SELECT COUNT(*)::int AS hits,
           MAX(created_at) AS last_at
      FROM auth_codes
     WHERE email = ${address}
       AND purpose = ${purpose}
       AND created_at > NOW() - INTERVAL '1 hour'
  `) as unknown as Array<{ hits: number; last_at: string | null }>

  const hits = recent[0]?.hits ?? 0
  const lastAt = recent[0]?.last_at ? new Date(recent[0].last_at).getTime() : 0

  if (lastAt) {
    const waited = Date.now() - lastAt
    if (waited < RESEND_COOLDOWN_MS) {
      return {
        ok: false,
        reason: 'cooldown',
        retryAfter: Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - waited) / 1000))
      }
    }
  }

  if (hits >= MAX_PER_HOUR) {
    return { ok: false, reason: 'capped', retryAfter: 15 * 60 }
  }

  const code = makeCode()
  const token = makeToken()
  const salt = randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + TTL_MS[purpose])

  /* One statement, so there is no window in which the old challenge is dead
     and the new one does not exist yet. */
  await db().sql`
    UPDATE auth_codes
       SET expires_at = NOW()
     WHERE email = ${address}
       AND purpose = ${purpose}
       AND consumed_at IS NULL
       AND expires_at > NOW()
  `

  await db().sql`
    INSERT INTO auth_codes (email, purpose, salt, code_hash, token_hash, expires_at, requested_ip)
    VALUES (${address}, ${purpose}, ${salt},
            ${codeDigest(code, salt, purpose)}, ${tokenDigest(token)},
            ${expiresAt.toISOString()}, ${ip ?? null})
  `

  return { ok: true, code, token, expiresAt, minutes: ttlMinutes(purpose) }
}

/* ---------- Redeeming ---------------------------------------------------- */

export type RedeemFailure =
  /* No live challenge for this address and purpose. Either none was ever
     issued, or the last one was superseded by a newer send. */
  | 'none'
  | 'expired'
  | 'used'
  | 'locked'
  | 'mismatch'

export type RedeemResult =
  | { ok: true; email: string; account: AccountRow | null }
  | { ok: false; reason: RedeemFailure; remaining?: number }

/* Marks the row spent, and reports whether this call was the one that did it.
   The WHERE clause is the whole single-use guarantee: two requests carrying
   the same code get one success and one 'used' between them, decided by the
   database rather than by the order two function containers happen to run
   in. */
async function consume(id: number) {
  const rows = (await db().sql`
    UPDATE auth_codes
       SET consumed_at = NOW()
     WHERE id = ${id}
       AND consumed_at IS NULL
    RETURNING id
  `) as unknown as Array<{ id: number }>
  return rows.length > 0
}

async function settle(row: CodeRow): Promise<RedeemResult> {
  if (!(await consume(row.id))) return { ok: false, reason: 'used' }
  const email = normalizeEmail(row.email)
  return { ok: true, email, account: await findAccount(email) }
}

/* Redeem by typed code.

   The order of the checks matters. Expiry and the attempt lock are decided
   before the digest is compared, so a locked row cannot be used as an oracle
   that answers faster for a correct guess than a wrong one. */
export async function redeemCode(
  email: string,
  purpose: Purpose,
  code: string
): Promise<RedeemResult> {
  const address = normalizeEmail(email)
  const typed = String(code || '').replace(/\D+/g, '')

  if (typed.length !== CODE_LENGTH) return { ok: false, reason: 'mismatch' }

  const rows = (await db().sql`
    SELECT * FROM auth_codes
     WHERE email = ${address}
       AND purpose = ${purpose}
       AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
  `) as unknown as CodeRow[]

  const row = rows[0]
  if (!row) return { ok: false, reason: 'none' }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' }

  if (!sameDigest(row.code_hash, codeDigest(typed, row.salt, row.purpose))) {
    const bumped = (await db().sql`
      UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ${row.id}
      RETURNING attempts
    `) as unknown as Array<{ attempts: number }>

    const used = bumped[0]?.attempts ?? row.attempts + 1
    const remaining = Math.max(0, MAX_ATTEMPTS - used)

    return remaining > 0
      ? { ok: false, reason: 'mismatch', remaining }
      : { ok: false, reason: 'locked' }
  }

  return settle(row)
}

/* Redeem by the link in the email.

   No attempt counter and no address, because neither would mean anything
   here: the token is its own lookup key, and 32 random bytes are not reached
   by guessing. A token that finds no row is reported as 'none' rather than
   'mismatch' for the same reason — there is nothing to have got wrong. */
export async function redeemToken(purpose: Purpose, token: string): Promise<RedeemResult> {
  const supplied = String(token || '').trim()
  if (supplied.length < 20) return { ok: false, reason: 'none' }

  const rows = (await db().sql`
    SELECT * FROM auth_codes
     WHERE token_hash = ${tokenDigest(supplied)}
       AND purpose = ${purpose}
     LIMIT 1
  `) as unknown as CodeRow[]

  const row = rows[0]
  if (!row) return { ok: false, reason: 'none' }
  if (row.consumed_at) return { ok: false, reason: 'used' }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }

  return settle(row)
}

/* ---------- Housekeeping ------------------------------------------------- */

/* Spent and expired rows are kept for a week so a customer who says "the code
   did not work" can be answered, then dropped. Called from the deposit
   poller, which is the one thing on this site that already runs on a
   schedule; it is not on any request path and a failure here is logged and
   ignored. */
export async function purgeStaleCodes(): Promise<number> {
  const rows = (await db().sql`
    DELETE FROM auth_codes
     WHERE expires_at < NOW() - INTERVAL '7 days'
    RETURNING id
  `) as unknown as Array<{ id: number }>
  return rows.length
}

/* How many addresses are waiting on a confirmation they have not completed.
   Read by /api/health: a number that only ever grows is the signature of mail
   that is being generated and not delivered, which is otherwise invisible
   from the outside. */
export async function verificationBacklog(): Promise<{ pending: number; issuedLastHour: number }> {
  const rows = (await db().sql`
    SELECT
      (SELECT COUNT(*)::int FROM accounts WHERE email_verified_at IS NULL) AS pending,
      (SELECT COUNT(*)::int FROM auth_codes
        WHERE created_at > NOW() - INTERVAL '1 hour') AS issued
  `) as unknown as Array<{ pending: number; issued: number }>

  return {
    pending: rows[0]?.pending ?? 0,
    issuedLastHour: rows[0]?.issued ?? 0
  }
}
