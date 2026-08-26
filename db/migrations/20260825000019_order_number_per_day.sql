-- migrate:up
-- =============================================================================
-- THE ORDER NUMBER RESETS DAILY; ITS UNIQUENESS DID NOT
-- =============================================================================
--
-- THE BUG, EXACTLY
--
-- `nextOrderNumber` counts the orders a court has taken SINCE LOCAL MIDNIGHT
-- and returns `A-{count + 1}`. That is the right product behaviour: the number
-- is shouted across a counter, so it has to be short, and it has to start again
-- each morning or it reaches A-4821 by March.
--
-- The uniqueness that backed it did not reset. Migration 1 created
--
--     CREATE UNIQUE INDEX order_public_number_uq
--       ON "order" (food_court_id, public_order_number);
--
-- which is permanent per court. So the first order of any day after the first
-- day is issued `A-001`, an `A-001` already exists in that court from an
-- earlier day, and the insert fails:
--
--     duplicate key value violates unique constraint "order_public_number_uq"
--
-- It does not self-heal. A retry counts today's orders again, gets zero again,
-- and proposes `A-001` again. From the first midnight onwards, a court that has
-- ever taken an order cannot take another one — the customer sees a 500 and the
-- stall never learns an order was attempted.
--
-- This was found from a real 500 on `POST /api/v1/orders`, not from review, and
-- no test covered order numbering at all.
--
-- -----------------------------------------------------------------------------
-- WHY A STORED business_date AND NOT AN EXPRESSION INDEX
-- -----------------------------------------------------------------------------
--
-- The obvious fix is to put the day in the index. It cannot be done directly:
-- `created_at` is TIMESTAMPTZ, and every expression that reduces one to a day
-- (`created_at::date`, `date_trunc('day', created_at)`) is STABLE rather than
-- IMMUTABLE, because the answer depends on the session's TimeZone. PostgreSQL
-- refuses them in an index for exactly the right reason: a value that changes
-- with a connection setting cannot be part of a key.
--
-- Forcing immutability with `(created_at AT TIME ZONE 'UTC')::date` would work
-- and would be wrong: a court in IST closing at 23:00 and reopening at 07:00
-- would roll its numbers over at 05:30 local, mid-service.
--
-- So the business day is a COLUMN the application sets. That also makes it a
-- decision rather than an accident — a court that trades past midnight can be
-- given a different rule later without touching an index definition.

ALTER TABLE "order"
  ADD COLUMN business_date DATE;

COMMENT ON COLUMN "order".business_date IS
  'The trading day this order belongs to, decided by the application, not derived '
  'from created_at. Scopes public_order_number: numbers restart each business day.';

-- -----------------------------------------------------------------------------
-- Backfill, in the server''s local zone, matching what the generator did.
-- -----------------------------------------------------------------------------
-- `created_at::date` is fine HERE — a one-off UPDATE has a known TimeZone and
-- is not an index expression. This reproduces the day boundary the old code
-- actually used, so existing numbers keep the meaning they were issued with.
UPDATE "order" SET business_date = created_at::date WHERE business_date IS NULL;

ALTER TABLE "order"
  ALTER COLUMN business_date SET NOT NULL;

-- -----------------------------------------------------------------------------
-- Swap the uniqueness.
-- -----------------------------------------------------------------------------
-- Dropped BEFORE the new one is created, deliberately. Existing rows almost
-- certainly violate the new key's stricter cousin and satisfy the looser one;
-- doing it in this order means the table is never held to both at once.
--
-- The new index is what the product always meant: this number is unique within
-- this court ON THIS DAY. Tomorrow's A-001 is a different order and always was.
DROP INDEX IF EXISTS order_public_number_uq;

CREATE UNIQUE INDEX order_public_number_uq
  ON "order" (food_court_id, business_date, public_order_number);

-- The generator now asks for the highest number issued today rather than
-- counting rows, so this is the index that has to be fast.
CREATE INDEX order_court_day_idx
  ON "order" (food_court_id, business_date);

-- migrate:down
DROP INDEX IF EXISTS order_court_day_idx;
DROP INDEX IF EXISTS order_public_number_uq;
CREATE UNIQUE INDEX order_public_number_uq ON "order" (food_court_id, public_order_number);
ALTER TABLE "order" DROP COLUMN IF EXISTS business_date;
