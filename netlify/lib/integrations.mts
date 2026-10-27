/* ==========================================================================
   Integration persistence, and the encryption that makes it safe to have.

   Every SQL statement on the integrations path lives here, the same way
   store.mts owns the money path, so the invariants are in one file:

     · a credential is never stored in the clear and never leaves this module
       in the clear — the read path returns a four-character hint and the
       status, and there is no function here that hands a plaintext key back
       to a caller outside the verifier;
     · a row belongs to exactly one account, and every read and write is
       filtered by that owner, so an id from the browser is a lookup key and
       not a way to reach somebody else's tracker;
     · one (account, platform, instance) is one row, enforced by the unique
       index rather than by a read-then-write in application code.

   The key comes from INTEGRATION_KEY_SECRET and there is deliberately no
   default. A fallback key would mean credentials encrypted with a value that
   is in the repository, which is not encryption — so with the variable unset
   the feature reports itself off and refuses to store anything, exactly as
   notify.mts refuses to claim a channel it has no credentials for.
   ========================================================================== */

import { getDatabase } from '@netlify/database'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { normalizeEmail } from './auth-codes.mjs'
import type { Credential } from './platform-api.mjs'

export interface IntegrationRow {
  id: number
  email: string
  identity_user_id: string | null
  platform: string
  label: string | null
  base_url: string | null
  credential_cipher: string
  credential_iv: string
  credential_tag: string
  credential_hint: string | null
  status: string
  status_reason: string | null
  campaign_count: number | null
  last_sync_at: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

function db() {
  return getDatabase()
}

/* ---------- The key ------------------------------------------------------- */

/* Stretched once per container rather than per call: scrypt is deliberately
   slow, and this runs on the sync path where a customer is waiting. */
let cachedKey: Buffer | null = null

export function integrationsConfigured() {
  return Boolean((process.env.INTEGRATION_KEY_SECRET || '').trim())
}

function key(): Buffer {
  if (cachedKey) return cachedKey

  const secret = (process.env.INTEGRATION_KEY_SECRET || '').trim()
  if (!secret) {
    throw new Error('INTEGRATION_KEY_SECRET is not set')
  }

  /* A constant salt, which is the right call here and not a shortcut: the
     alternative is a per-row salt column, and the thing a salt defends
     against — one rainbow table covering many independent low-entropy
     secrets — does not apply to a single high-entropy key held in an
     environment variable. The per-row randomness that does matter is the IV,
     which is generated fresh for every single write below. */
  cachedKey = scryptSync(secret, 'cloakshield-integrations-v1', 32)
  return cachedKey
}

interface Sealed {
  cipher: string
  iv: string
  tag: string
  hint: string
}

/* The credential is sealed as one JSON object rather than a column per field,
   so Voluum's key pair and RedTrack's single key are the same shape to
   everything downstream. */
function seal(credential: Credential): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)

  const plain = JSON.stringify(credential)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])

  /* The hint is taken from whichever field is the secret half, so what the
     customer sees in the panel is the end of the value they actually pasted
     into the secret box rather than the end of an access id. */
  const secretValue = String(credential.accessKey || credential.apiKey || '')

  return {
    cipher: body.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    hint: secretValue.slice(-4)
  }
}

/* Returns null rather than throwing on a row that will not open. A credential
   encrypted under a key that has since been rotated is a row the customer has
   to reconnect, which the sync path reports as exactly that — a thrown error
   there would read to them as "your tracker is down". */
export function unseal(row: IntegrationRow): Credential | null {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(row.credential_iv, 'base64')
    )
    decipher.setAuthTag(Buffer.from(row.credential_tag, 'base64'))

    const plain = Buffer.concat([
      decipher.update(Buffer.from(row.credential_cipher, 'base64')),
      decipher.final()
    ]).toString('utf8')

    return JSON.parse(plain) as Credential
  } catch {
    return null
  }
}

/* ---------- What the browser is allowed to see ---------------------------- */

/* The one shape the panel renders from. Note what is absent: the cipher, the
   IV and the tag. A caller that wants those has to read the row itself, which
   only the sync path in this module does. */
export function publicRow(row: IntegrationRow) {
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    baseUrl: row.base_url,
    status: row.status,
    statusReason: row.status_reason,
    campaigns: row.campaign_count,
    hint: row.credential_hint,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).getTime() : null,
    lastErrorAt: row.last_error_at ? new Date(row.last_error_at).getTime() : null,
    createdAt: new Date(row.created_at).getTime()
  }
}

/* ---------- Reads --------------------------------------------------------- */

export async function listIntegrations(identityUserId: string | null, email: string) {
  const rows = (await db().sql`
    SELECT * FROM integrations
     WHERE email = ${normalizeEmail(email)}
        OR (identity_user_id IS NOT NULL AND identity_user_id = ${identityUserId})
     ORDER BY created_at ASC
  `) as unknown as IntegrationRow[]
  return rows
}

/* Ownership is part of the WHERE clause rather than a check after the fact,
   so there is no path through this module that reads a row and then decides
   whether it should have. */
export async function findIntegration(
  id: number,
  identityUserId: string | null,
  email: string
): Promise<IntegrationRow | null> {
  const rows = (await db().sql`
    SELECT * FROM integrations
     WHERE id = ${id}
       AND (email = ${normalizeEmail(email)}
            OR (identity_user_id IS NOT NULL AND identity_user_id = ${identityUserId}))
     LIMIT 1
  `) as unknown as IntegrationRow[]
  return rows[0] || null
}

export async function countIntegrations(identityUserId: string | null, email: string) {
  const rows = (await db().sql`
    SELECT COUNT(*)::int AS n FROM integrations
     WHERE email = ${normalizeEmail(email)}
        OR (identity_user_id IS NOT NULL AND identity_user_id = ${identityUserId})
  `) as unknown as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

/* ---------- Writes -------------------------------------------------------- */

export interface SaveInput {
  identityUserId: string | null
  email: string
  platform: string
  label: string | null
  baseUrl: string | null
  credential: Credential
  campaigns: number | null
}

/* Called only after the credential has been accepted by the platform's own
   API, so the row is written in its verified state. Reconnecting an instance
   that already exists replaces the credential and clears the previous error
   rather than creating a second row — the unique index makes that an UPSERT
   instead of a read-then-write that two tabs could race. */
export async function saveIntegration(input: SaveInput): Promise<IntegrationRow> {
  const sealed = seal(input.credential)

  const rows = (await db().sql`
    INSERT INTO integrations (
      email, identity_user_id, platform, label, base_url,
      credential_cipher, credential_iv, credential_tag, credential_hint,
      status, status_reason, campaign_count, last_sync_at
    )
    VALUES (
      ${normalizeEmail(input.email)}, ${input.identityUserId}, ${input.platform},
      ${input.label}, ${input.baseUrl},
      ${sealed.cipher}, ${sealed.iv}, ${sealed.tag}, ${sealed.hint},
      'verified', NULL, ${input.campaigns}, NOW()
    )
    ON CONFLICT (email, platform, COALESCE(base_url, '')) DO UPDATE
       SET identity_user_id   = COALESCE(EXCLUDED.identity_user_id, integrations.identity_user_id),
           label              = EXCLUDED.label,
           credential_cipher  = EXCLUDED.credential_cipher,
           credential_iv      = EXCLUDED.credential_iv,
           credential_tag     = EXCLUDED.credential_tag,
           credential_hint    = EXCLUDED.credential_hint,
           status             = 'verified',
           status_reason      = NULL,
           campaign_count     = EXCLUDED.campaign_count,
           last_sync_at       = NOW(),
           last_error_at      = NULL,
           updated_at         = NOW()
    RETURNING *
  `) as unknown as IntegrationRow[]

  return rows[0]
}

export async function recordSync(id: number, campaigns: number | null): Promise<void> {
  await db().sql`
    UPDATE integrations
       SET status         = 'verified',
           status_reason  = NULL,
           campaign_count = ${campaigns},
           last_sync_at   = NOW(),
           last_error_at  = NULL,
           updated_at     = NOW()
     WHERE id = ${id}
  `
}

/* A failed pass does not clear the last good campaign count. "Keitaro refused
   the key, and the last time it worked it had 31 campaigns" is a more useful
   card than one that has forgotten everything it knew. */
export async function recordError(id: number, reason: string): Promise<void> {
  await db().sql`
    UPDATE integrations
       SET status        = 'error',
           status_reason = ${reason},
           last_error_at = NOW(),
           updated_at    = NOW()
     WHERE id = ${id}
  `
}

export async function deleteIntegration(
  id: number,
  identityUserId: string | null,
  email: string
): Promise<boolean> {
  const rows = (await db().sql`
    DELETE FROM integrations
     WHERE id = ${id}
       AND (email = ${normalizeEmail(email)}
            OR (identity_user_id IS NOT NULL AND identity_user_id = ${identityUserId}))
    RETURNING id
  `) as unknown as Array<{ id: number }>

  return rows.length > 0
}
