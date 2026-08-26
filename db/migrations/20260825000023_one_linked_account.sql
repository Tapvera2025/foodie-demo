-- migrate:up
-- =============================================================================
-- TWO COLUMNS FOR ONE FACT, COLLAPSED BACK TO ONE
-- =============================================================================
--
-- THE MISTAKE
--
-- Migration 18 added `vendor.cashfree_vendor_id` for the payee handle Easy
-- Split routes to. `vendor.provider_linked_account_id` already existed, from
-- migration 1, for exactly that — and it is the one with everything attached:
--
--   * the CHECK constraint `vendor_platform_collect_needs_linked_account`,
--     which refuses an ACTIVE PLATFORM_COLLECT stall without one
--   * `vendor-onboarding.ts`, which fails readiness with PROVIDER_ACCOUNT_MISSING
--   * the admin console's "Payment provider linked account" field
--
-- Nothing was attached to the new one except the split code written alongside
-- it. So the two drifted immediately and in the worst possible direction: the
-- console wrote `provider_linked_account_id`, the split read
-- `cashfree_vendor_id`, and a stall onboarded entirely through the UI showed as
-- fully configured while `order.repository` refused every order it tried to
-- take. Meanwhile a stall set up by the script satisfied the split and left the
-- console's own field empty.
--
-- Two sources of truth for one fact, in the money path. Neither was wrong on
-- its own, which is precisely why it survived — every individual screen and
-- query was self-consistent.
--
-- -----------------------------------------------------------------------------
-- WHY `provider_linked_account_id` IS THE SURVIVOR
-- -----------------------------------------------------------------------------
--
-- It is older, the database already enforces it, the console already writes it,
-- and onboarding already validates it. Keeping the newer column would mean
-- moving a CHECK constraint, rewriting the console form, and changing an
-- onboarding rule — to end up where this migration starts.
--
-- It is also the better NAME. The value is a payee handle at whichever
-- aggregator is configured; `cashfree_vendor_id` bakes today's provider into a
-- column, and PRD §19 decision 2 is explicitly still open.
--
-- -----------------------------------------------------------------------------
-- ORDER OF OPERATIONS
-- -----------------------------------------------------------------------------
--
-- Backfill BEFORE dropping, and only where the target is null — a stall that
-- has both set, with different values, keeps the one the constraint and the
-- console agree about. There is no automated way to know which of two payee
-- handles is the live one, and picking the wrong one sends a stall's money to
-- an account nobody is watching.

UPDATE vendor
   SET provider_linked_account_id = cashfree_vendor_id
 WHERE provider_linked_account_id IS NULL
   AND cashfree_vendor_id IS NOT NULL;

ALTER TABLE vendor DROP COLUMN IF EXISTS cashfree_vendor_id;

COMMENT ON COLUMN vendor.provider_linked_account_id IS
  'The payee handle at the configured aggregator — for Cashfree, the Easy '
  'Split vendor_id that order_splits routes to. The ONE column for this; '
  'migration 18 briefly added a second (cashfree_vendor_id) and migration 23 '
  'collapsed them after the two drifted apart. Guarded by '
  'vendor_platform_collect_needs_linked_account.';

-- migrate:down
-- Restores the column and copies the value back, so a rollback leaves the split
-- path able to find a handle. The duplication returns with it — that is what
-- rolling back to a worse shape means, and it is better than a rollback that
-- silently stops every PLATFORM_COLLECT stall from being paid.
ALTER TABLE vendor ADD COLUMN IF NOT EXISTS cashfree_vendor_id TEXT;

UPDATE vendor
   SET cashfree_vendor_id = provider_linked_account_id
 WHERE cashfree_vendor_id IS NULL
   AND provider_linked_account_id IS NOT NULL;
