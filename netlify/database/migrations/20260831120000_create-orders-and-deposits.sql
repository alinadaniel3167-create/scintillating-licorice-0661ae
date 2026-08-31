-- Orders and observed deposits.
--
-- Two tables, and the split matters: `orders` is what the site promised a
-- customer, `deposits` is what actually turned up in the MEXC account. The
-- poller reconciles one against the other. Recording every deposit — matched
-- or not — is what makes an unattributable payment a review item rather than
-- a lost one.

CREATE TABLE orders (
  id                SERIAL PRIMARY KEY,

  -- CS-XXXXXX, shown to the customer and quoted in support mail.
  reference         TEXT NOT NULL UNIQUE,

  -- Netlify Identity owns the account; this is the link back to it.
  identity_user_id  TEXT,
  email             TEXT NOT NULL,

  plan              TEXT NOT NULL,
  months            INTEGER NOT NULL,
  amount_usd        NUMERIC(12, 2) NOT NULL,

  -- Which of the six checkout options was picked. `coin` and `network` are
  -- the MEXC-side names; `asset_id` is ours (btc, usdt-erc20, …).
  asset_id          TEXT NOT NULL,
  coin              TEXT NOT NULL,
  network           TEXT NOT NULL,
  address           TEXT NOT NULL,

  -- The amount the customer was told to send, carrying the per-order cent
  -- jitter that makes an incoming deposit attributable. Never rounded again.
  expected_amount   NUMERIC(28, 10) NOT NULL,
  locked_rate       NUMERIC(28, 10) NOT NULL,

  -- awaiting   order created, no transfer seen
  -- confirming a transfer is on chain but not yet credited by MEXC
  -- paid        credited; the workspace is unlocked
  -- cancelled   abandoned or superseded
  status            TEXT NOT NULL DEFAULT 'awaiting',

  -- Set once a deposit is matched. Unique so one transfer can never pay for
  -- two orders, whatever a customer pastes into the claim box.
  tx_hash           TEXT UNIQUE,
  deposit_network   TEXT,
  confirmations     TEXT,

  -- The rate lock expires; the order does not. A transfer that arrives late
  -- still has somewhere to land, which is the whole point.
  rate_expires_at   TIMESTAMPTZ NOT NULL,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orders_email_idx ON orders (email);
CREATE INDEX orders_identity_user_idx ON orders (identity_user_id);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_coin_amount_idx ON orders (coin, expected_amount);

-- The attribution guarantee. Two open orders may never quote the same coin
-- and amount, so an incoming deposit can match at most one of them. Closed
-- orders drop out of the index, which keeps the jitter space small.
CREATE UNIQUE INDEX orders_open_amount_uniq
  ON orders (coin, expected_amount)
  WHERE status IN ('awaiting', 'confirming');

CREATE TABLE deposits (
  id                SERIAL PRIMARY KEY,

  -- MEXC's txId. Unique, so repeated polls of the same 7-day window are
  -- idempotent and an outage can be replayed safely.
  tx_id             TEXT NOT NULL UNIQUE,

  coin              TEXT NOT NULL,
  network           TEXT,
  amount            NUMERIC(28, 10) NOT NULL,
  address           TEXT,

  -- MEXC's numeric deposit status, kept raw. 5 SUCCESS and 12 COMPLETED are
  -- the only two that credit an order; the rest are informational or need a
  -- human, and storing the code means we can tell which after the fact.
  mexc_status       INTEGER,
  confirm_times     TEXT,
  unlock_confirm    TEXT,
  insert_time       TIMESTAMPTZ,

  matched_order_id  INTEGER REFERENCES orders (id),

  -- Why this deposit is sitting unmatched. Null once it is matched.
  review_reason     TEXT,

  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX deposits_matched_idx ON deposits (matched_order_id);
CREATE INDEX deposits_review_idx ON deposits (review_reason) WHERE review_reason IS NOT NULL;

-- Single-row-per-key scratch space for operational state — currently the
-- outcome of the last poll, which /api/health reads so a lapsed MEXC key is
-- visible rather than silent.
CREATE TABLE system_state (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
