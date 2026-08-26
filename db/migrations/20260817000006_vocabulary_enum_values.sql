-- migrate:up
--
-- Enum VALUES only. Nothing in this file uses them.
--
-- WHY THIS IS A MIGRATION OF ITS OWN
--
-- PostgreSQL permits `ALTER TYPE ... ADD VALUE` inside a transaction block from
-- v12 onward, but it does NOT permit the new value to be *used* before that
-- transaction commits:
--
--     ERROR: unsafe use of new value "COLLECTED" of enum type order_status
--
-- The migration runner wraps each file in one transaction, so adding a value
-- and then writing it in the same file fails — and fails at the point where the
-- data migration runs, i.e. after the schema change has already been half
-- applied in someone's head. Splitting the two is not tidiness. It is the only
-- ordering that works.
--
-- 20260817000007 is the file that uses these.
--
-- ---------------------------------------------------------------------------
-- PRD §7.1 — COLLECTED, not COMPLETED
--
-- "Cooked" and "handed over" are different events and the gap between them is a
-- real queue. COMPLETED was vague about completed-by-whom and let the two
-- collapse into one number, which is precisely the number a stall would be
-- measured on.
--
-- PRD §7.2 — PAYMENT_EXPIRED, distinct from PAYMENT_FAILED
--
-- Failed means declined; something happened and can be explained to a customer.
-- Expired means no outcome arrived in the window, so nothing was declined and
-- there is nothing to explain. Reporting them as one number hides how many
-- customers simply walked away mid-payment, which is the abandonment signal.
--
-- PRD §8 — the payment lifecycle is its own state machine
--
-- `SUCCESS` cannot represent the interval between "the money is blocked" and
-- "the money is taken", and that interval is the entire mechanism behind
-- PAYMENTS_SPLIT_TIMING=ON_ACKNOWLEDGED: block at checkout, take when the
-- kitchen accepts, release instantly if no stall ever does. It is also the
-- shape of UPI single-block-multi-debit, which PRD §19.1 names as the correct
-- long-term primitive. One SUCCESS state makes that unimplementable.
--
-- Values are added, never removed: PostgreSQL cannot drop an enum label. The
-- retired ones (COMPLETED, INITIATED, SUCCESS) are fenced off by CHECK
-- constraints in the next migration so that "unused" is enforced rather than
-- assumed.

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'COLLECTED';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'PAYMENT_EXPIRED';

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'CREATED';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'AUTHORIZED';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'CAPTURED';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';

-- migrate:down
-- Not implemented, and not implementable: PostgreSQL cannot drop an enum label.
-- Reversing this means recreating both types and rewriting every column that
-- uses them, which is a forward migration wearing a costume.
SELECT 'irreversible: enum labels cannot be dropped' AS note;
