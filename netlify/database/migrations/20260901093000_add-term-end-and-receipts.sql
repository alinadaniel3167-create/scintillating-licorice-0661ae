-- When a paid term ends, and whether its receipt went out.
--
-- Before this, `paid` was forever. An order that credited in January still
-- read as an active plan in December, because nothing anywhere recorded when
-- the term the customer bought actually ran out. Crypto cannot auto-charge, so
-- the end of a term is the only thing that can ask for a renewal.
--
-- The date is written once, when the deposit is credited, and expiry is then a
-- read-time comparison. No job has to run for a term to lapse — which matters
-- on a site whose only scheduled function is the deposit poller.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS term_ends_at    TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_sent_at TIMESTAMPTZ;

-- Existing paid orders predate the column. Their real chain of terms is not
-- reconstructible, so each one is treated as having started when it was
-- credited, which is what a customer would say happened.
UPDATE orders
   SET term_ends_at = paid_at + ((months)::text || ' months')::interval
 WHERE status = 'paid'
   AND paid_at IS NOT NULL
   AND term_ends_at IS NULL;

-- Answering "whose plan has lapsed" without a table scan.
CREATE INDEX IF NOT EXISTS orders_term_end_idx
  ON orders (term_ends_at)
  WHERE status = 'paid';
