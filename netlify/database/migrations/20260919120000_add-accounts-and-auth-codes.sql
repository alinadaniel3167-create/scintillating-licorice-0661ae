-- Email verification and password reset, owned by this site.
--
-- Until now both of those messages were Netlify Identity's to send: Identity
-- minted the token internally, rendered one of the templates in
-- email-templates/ and dispatched it through whatever mail server the Identity
-- settings pointed at. That works, but only after somebody fills in an SMTP
-- form by hand, and nothing on the site can tell whether they did — a project
-- with a Resend key sitting in its environment and an empty Identity mail
-- setting sends no confirmation email at all and reports no error.
--
-- So the tokens move here. These two tables are what that needs.
--
-- `accounts` is the site's own record of an address: which Identity user it
-- belongs to, and whether the person holding it has ever proved they can read
-- its inbox. Identity still owns the password, the hashing and the session —
-- this is only the link back to it plus the one fact Identity cannot answer
-- once signups are created confirmed, which is whether the address was
-- verified rather than merely typed.
--
-- `auth_codes` is a single-use challenge: a six-digit code the customer can
-- type and a long token the same message carries as a link, either of which
-- redeems it. Only the hashes are stored, so a copy of this table is not a
-- set of working codes.

CREATE TABLE IF NOT EXISTS accounts (
  id                SERIAL PRIMARY KEY,

  -- Lower-cased and trimmed before it is written, so the unique constraint is
  -- a constraint on the address rather than on its spelling.
  email             TEXT NOT NULL UNIQUE,

  -- Identity owns the credentials; this is the join back to them. Nullable
  -- because a row can outlive the Identity user it was created for.
  identity_user_id  TEXT,

  full_name         TEXT,

  -- The plan the visitor was reading when they registered, carried so the
  -- welcome email can name it. Display only — nothing is billed from here.
  signup_plan       TEXT,
  signup_months     TEXT,

  -- NULL means the address has never been proved. Sign-in refuses an account
  -- in that state, which is what makes this column a gate and not a label.
  -- Written once, on the first successful redemption.
  email_verified_at TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id                SERIAL PRIMARY KEY,

  email             TEXT NOT NULL,

  -- 'signup'   confirm a new address
  -- 'recovery' set a new password
  --
  -- Separate on purpose: a code mailed to confirm an address must not be
  -- usable to change the password on it, so the purpose is part of the lookup
  -- rather than a note about it.
  purpose           TEXT NOT NULL,

  -- SHA-256 of the six digits, and of the link token, each salted with the
  -- row's own random salt. Neither the code nor the token is recoverable from
  -- this table, which is the point: the customer's inbox is the only place
  -- either one exists in the clear.
  salt              TEXT NOT NULL,
  code_hash         TEXT NOT NULL,
  token_hash        TEXT NOT NULL,

  -- Wrong guesses against this row. A six-digit code is a million
  -- possibilities, which is plenty against a human and nothing against a
  -- script, so the row dies after a handful of misses rather than waiting to
  -- expire.
  attempts          INTEGER NOT NULL DEFAULT 0,

  expires_at        TIMESTAMPTZ NOT NULL,

  -- Set the moment the code or the token is accepted. Single use is enforced
  -- by this column being NULL in the lookup, not by deleting the row: a
  -- second attempt should be able to tell "already used" from "never existed".
  consumed_at       TIMESTAMPTZ,

  -- Kept for the resend cooldown and the hourly cap, both of which are
  -- questions about how often this address has asked rather than about any
  -- one request.
  requested_ip      TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The hot path: "is there a live code for this address and purpose". Partial,
-- because a spent or expired row is never the answer to it.
CREATE INDEX IF NOT EXISTS auth_codes_open_idx
  ON auth_codes (email, purpose, created_at DESC)
  WHERE consumed_at IS NULL;

-- Redeeming a link goes straight to the token. Unique so two rows can never
-- answer to one token, whatever the random generator does.
CREATE UNIQUE INDEX IF NOT EXISTS auth_codes_token_uniq
  ON auth_codes (token_hash);

-- Sweeping expired rows, and counting recent requests for the hourly cap.
CREATE INDEX IF NOT EXISTS auth_codes_expiry_idx
  ON auth_codes (expires_at);

-- Accounts that predate this table.
--
-- Anyone who registered before it existed has an Identity user and no row
-- here, and the sign-in gate is written to let those through: no row means
-- Identity's own confirmation state decides, exactly as it did before. The
-- backfill below turns that fallback into a real record wherever the orders
-- table can prove the address was already in use, so the common case does not
-- rely on the fallback at all. An address that reached checkout had a
-- confirmed email under the old flow, because an unconfirmed one could not
-- hold the session /api/order requires.
INSERT INTO accounts (email, identity_user_id, email_verified_at, created_at)
SELECT DISTINCT ON (LOWER(TRIM(o.email)))
       LOWER(TRIM(o.email)),
       o.identity_user_id,
       MIN(o.created_at) OVER (PARTITION BY LOWER(TRIM(o.email))),
       MIN(o.created_at) OVER (PARTITION BY LOWER(TRIM(o.email)))
  FROM orders o
 WHERE o.email IS NOT NULL
   AND TRIM(o.email) <> ''
 ORDER BY LOWER(TRIM(o.email)), o.created_at ASC
ON CONFLICT (email) DO NOTHING;
