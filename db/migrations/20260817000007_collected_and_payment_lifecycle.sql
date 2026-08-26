-- migrate:up
--
-- Uses the enum values added in 20260817000006, migrates the data onto them,
-- and then fences off the retired ones so they cannot come back.
--
-- THIS MIGRATION REWRITES APPEND-ONLY HISTORY. READ THIS BEFORE COPYING IT.
--
-- `order_status_history` refuses UPDATE from every role including superusers
-- (20260810000002). That guarantee is real and this migration suspends it, by
-- name, in a transaction, and then proves it came back — the same deliberate
-- door as scripts/reset-orders.ts rather than a quiet weakening.
--
-- It is safe to do here for one reason and one reason only: there is no
-- production order history yet. COMPLETED and COLLECTED are the same event
-- under two names, so rewriting the label loses nothing. Once a real customer
-- has been handed real food, this technique stops being available and a
-- vocabulary change costs a compensating entry instead. That is the correct
-- price; it is simply not payable today, and today is the last day it is free.

-- ===========================================================================
-- 1. ORDER: COMPLETED becomes COLLECTED
-- ===========================================================================

ALTER TABLE "order" RENAME COLUMN completed_at TO collected_at;

UPDATE "order" SET status = 'COLLECTED' WHERE status = 'COMPLETED';

ALTER TABLE order_status_history DISABLE TRIGGER USER;

UPDATE order_status_history SET to_status   = 'COLLECTED' WHERE to_status   = 'COMPLETED';
UPDATE order_status_history SET from_status = 'COLLECTED' WHERE from_status = 'COMPLETED';

ALTER TABLE order_status_history ENABLE TRIGGER USER;

-- Prove the guard is back. `ENABLE TRIGGER` inside a transaction that later
-- rolled back would leave history editable and nothing else in the system
-- would notice — the exact shape of PRD §2.2, a check whose failure mode is
-- silence. So this attempts the forbidden thing and requires a refusal.
DO $$
DECLARE refused BOOLEAN := false;
BEGIN
  BEGIN
    UPDATE order_status_history SET reason = reason WHERE false;
  EXCEPTION WHEN restrict_violation THEN
    refused := true;
  END;

  IF NOT refused THEN
    RAISE EXCEPTION 'append-only guard on order_status_history did not come back'
      USING HINT = 'Do not trust any status history written since. Run npm run verify:db.';
  END IF;
END $$;

-- COMPLETED is now unreachable. PostgreSQL cannot drop an enum label, so the
-- label survives; these constraints are what make "retired" a fact rather than
-- a convention someone will breach in six months by autocomplete.
ALTER TABLE "order"
  ADD CONSTRAINT order_status_not_completed
  CHECK (status <> 'COMPLETED');

ALTER TABLE order_status_history
  ADD CONSTRAINT osh_status_not_completed
  CHECK (to_status <> 'COMPLETED' AND (from_status IS NULL OR from_status <> 'COMPLETED'));

COMMENT ON CONSTRAINT order_status_not_completed ON "order" IS
  'PRD §7.1. COMPLETED was renamed COLLECTED because cooked and handed over are '
  'different events. The enum label cannot be dropped; this refuses it instead.';

-- ===========================================================================
-- 2. PAYMENT: a lifecycle of its own  (PRD §8)
-- ===========================================================================

-- succeeded_at is renamed rather than kept alongside captured_at. Two columns
-- meaning almost the same thing is how one of them goes stale, and "succeeded"
-- carries the same ambiguity as the SUCCESS state it belongs to: succeeded at
-- being blocked, or succeeded at being taken?
ALTER TABLE payment RENAME COLUMN succeeded_at TO captured_at;

ALTER TABLE payment
  ADD COLUMN authorized_at  TIMESTAMPTZ,
  -- When the block or the intent lapses. PRD §9 PAY-REC-06: no outcome inside
  -- the window is EXPIRED, not FAILED, and any block is released.
  ADD COLUMN expires_at     TIMESTAMPTZ,
  -- Running total returned. Lets PARTIALLY_REFUNDED be a checkable claim
  -- rather than a label somebody sets by hand.
  ADD COLUMN refunded_paise BIGINT NOT NULL DEFAULT 0;

-- Existing rows first, constraints after — the reverse order fails on data
-- that was correct under the old vocabulary.
UPDATE payment SET refunded_paise = amount_paise WHERE status = 'REFUNDED';

UPDATE payment SET status = 'CAPTURED' WHERE status = 'SUCCESS';
UPDATE payment SET status = 'CREATED'  WHERE status = 'INITIATED';

-- A CAPTURED row migrated from SUCCESS has no capture timestamp unless it had
-- a succeeded_at, which it did. Any that somehow does not gets one, because
-- the constraint below is about to require it and a NULL here means we do not
-- know when money moved.
UPDATE payment SET captured_at = created_at WHERE status = 'CAPTURED' AND captured_at IS NULL;

ALTER TABLE payment ALTER COLUMN status SET DEFAULT 'CREATED';

ALTER TABLE payment
  ADD CONSTRAINT payment_status_not_retired
    CHECK (status NOT IN ('INITIATED', 'SUCCESS')),

  -- Narrow on purpose. Only the state that asserts the event requires the
  -- stamp; a payment that has moved on to REFUNDED is not re-checked, because
  -- backfilling history we never observed would be inventing it.
  ADD CONSTRAINT payment_authorized_is_stamped
    CHECK (status <> 'AUTHORIZED' OR authorized_at IS NOT NULL),
  ADD CONSTRAINT payment_captured_is_stamped
    CHECK (status <> 'CAPTURED' OR captured_at IS NOT NULL),

  ADD CONSTRAINT payment_refunded_within_amount
    CHECK (refunded_paise >= 0 AND refunded_paise <= amount_paise),
  ADD CONSTRAINT payment_partial_refund_is_partial
    CHECK (status <> 'PARTIALLY_REFUNDED' OR (refunded_paise > 0 AND refunded_paise < amount_paise)),
  ADD CONSTRAINT payment_full_refund_is_full
    CHECK (status <> 'REFUNDED' OR refunded_paise = amount_paise);

-- ---------------------------------------------------------------------------
-- A retry is a NEW payment on the SAME order.
--
-- `payment_order_uq` was a plain unique index on (order_id): one payment row
-- per order, for ever. That makes several things the PRD requires impossible:
--
--   §7.2   "Customer may retry; a retry is a new payment on the same order"
--   §8     "One order can have several payment attempts"
--   §9 A   customer pays, closes the browser, comes back and pays again
--
-- Under the old index the second attempt could only overwrite the first, which
-- destroys the evidence of what happened on the first — the exact record you
-- need when a customer says they were charged twice.
--
-- What the index was actually protecting is worth keeping: an order must never
-- have two LIVE intents at once, because that is how one basket produces two
-- charges. So the constraint narrows from "one ever" to "one at a time".
--
-- The predicate is an EXCLUSION rather than a list of live states, deliberately.
-- A payment state added later and classified by nobody then counts as live and
-- restricts, rather than counting as dead and quietly permitting a second
-- simultaneous charge.
-- ---------------------------------------------------------------------------

DROP INDEX payment_order_uq;

CREATE UNIQUE INDEX payment_one_live_per_order
  ON payment (order_id)
  WHERE status NOT IN ('FAILED', 'EXPIRED');

COMMENT ON INDEX payment_one_live_per_order IS
  'PRD §7.2/§8. At most one live payment per order. Failed and expired attempts '
  'remain as history — a customer disputing a double charge needs both rows.';

CREATE INDEX payment_order_status_idx ON payment (order_id, status);

-- An intent waiting for an outcome. The expiry sweeper reads exactly this.
CREATE INDEX payment_expiry_idx ON payment (expires_at)
  WHERE status IN ('CREATED', 'PENDING', 'AUTHORIZED');

-- ===========================================================================
-- 3. THE BINDING RULE  (PRD §8.2, §7.4)
-- ===========================================================================
--
--   ORDER.PAYMENT_CONFIRMED requires PAYMENT.AUTHORIZED or PAYMENT.CAPTURED.
--
-- The PRD states this as a rule. A rule stated in a document is enforced by
-- whoever last read the document. This makes it a property of the database, so
-- the only way to confirm an order is to have first written a payment row that
-- a verified provider event put into an authorised state.
--
-- Which of the two suffices depends on PAYMENTS_SPLIT_TIMING and that stays in
-- the application, where the configuration lives. What cannot be configured
-- away is that one of them must hold.
--
-- Cross-table, so it cannot be a CHECK. A trigger is the only shape available
-- and it is the correct one: the check belongs at the moment of transition.

CREATE OR REPLACE FUNCTION assert_payment_backs_confirmation() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'PAYMENT_CONFIRMED' AND OLD.status IS DISTINCT FROM 'PAYMENT_CONFIRMED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payment p
      WHERE p.order_id = NEW.id
        AND p.status IN ('AUTHORIZED', 'CAPTURED')
    ) THEN
      RAISE EXCEPTION
        'order % cannot become PAYMENT_CONFIRMED: no payment on it is AUTHORIZED or CAPTURED',
        NEW.public_order_number
        USING ERRCODE = 'check_violation',
              HINT = 'PRD §7.4. A browser returning from a payment page is a hint, not '
                     'evidence. Confirmation follows a server-verified provider event.';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER order_confirmation_requires_payment
  BEFORE UPDATE ON "order"
  FOR EACH ROW EXECUTE FUNCTION assert_payment_backs_confirmation();

-- migrate:down
-- See 20260810000001. Down-migrations on financial data are how you lose the
-- ledger; roll the application back instead.
SELECT 'not implemented' AS note;
