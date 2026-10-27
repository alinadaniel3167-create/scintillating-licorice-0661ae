-- Platform integrations: the customer's own tracker or cloaker, connected by API.
--
-- Until now the "Connected platforms" panel on dashboard.html was five
-- hand-written cards with invented campaign counts in them — part of the
-- sample workspace, like the verdict log above it. This table is what makes
-- that panel answer for a real account instead.
--
-- One row is one (customer, platform, instance). The credential is the whole
-- reason this needs care: a Keitaro admin key is full control of that
-- customer's tracker, so it is stored encrypted with a key that lives in the
-- environment and never in this table, and nothing on the read path ever
-- returns it. What the browser sees is `credential_hint` — the last four
-- characters — which is enough for somebody to recognise which key they
-- pasted and useless to anybody who gets a copy of the rows.
--
-- What this table deliberately is NOT: a record of traffic flowing through
-- CloakShield. `status = 'verified'` means the credential was accepted by the
-- platform's own API and the campaign list could be read. Routing, scoring
-- and postback replay are a separate layer that does not exist yet, so no
-- column here should ever be rendered as though it did.

CREATE TABLE IF NOT EXISTS integrations (
  id                SERIAL PRIMARY KEY,

  -- Ownership, written the same way the rest of the site writes it: the
  -- Identity id when there is one, the lower-cased address always. Both,
  -- because every lookup elsewhere on this site matches on either — see
  -- findPaidOrderForUser in netlify/lib/store.mts.
  email             TEXT NOT NULL,
  identity_user_id  TEXT,

  -- 'keitaro' | 'voluum' | 'binom' | 'redtrack'. Validated against
  -- netlify/lib/platforms.mts on the way in rather than by a CHECK, so adding
  -- a platform is one entry in that file and not a migration.
  platform          TEXT NOT NULL,

  -- The customer's own name for this instance, when they have two.
  label             TEXT,

  -- Origin only (scheme + host + port), for the self-hosted platforms.
  -- Normalised and checked against the SSRF guard in platform-api.mts before
  -- it is ever written; NULL for the hosted ones, whose host is fixed.
  base_url          TEXT,

  -- AES-256-GCM. The key is derived from INTEGRATION_KEY_SECRET in the
  -- environment, so a dump of this table decrypts to nothing.
  credential_cipher TEXT NOT NULL,
  credential_iv     TEXT NOT NULL,
  credential_tag    TEXT NOT NULL,

  -- Last four characters of the credential, in the clear, for display.
  credential_hint   TEXT,

  -- 'verified' — the platform's API accepted the credential on the last pass
  -- 'error'    — it refused, or could not be reached; status_reason says which
  -- 'disabled' — the customer turned it off without deleting it
  status            TEXT NOT NULL DEFAULT 'verified',
  status_reason     TEXT,

  -- What the last successful pass could read. NULL means never read.
  campaign_count    INTEGER,

  last_sync_at      TIMESTAMPTZ,
  last_error_at     TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A customer with two Keitaro instances is ordinary; a customer with two rows
-- for the same instance is a bug. COALESCE because base_url is NULL for the
-- hosted platforms and NULL is not equal to itself in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_owner_platform_uniq
  ON integrations (email, platform, COALESCE(base_url, ''));

-- The only read the panel makes: everything this account has connected.
CREATE INDEX IF NOT EXISTS integrations_owner_idx
  ON integrations (email, created_at DESC);
