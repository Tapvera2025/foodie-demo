-- migrate:up
-- =============================================================================
-- CASHFREE: THE STALL'S PAYOUT IDENTITY, AND WHICH MODE IT SETTLES IN
-- =============================================================================
--
-- PRD §14.2 defines two settlement modes and the `settlement_mode` enum has
-- existed since migration 1. Orders already snapshot it (`settlement_mode` on
-- `order`), which is the part that matters for correctness — changing a stall's
-- mode must not restate last week's money.
--
-- What was missing is the SOURCE the snapshot is taken from. There was no
-- per-stall setting, so every order snapshotted the same platform-wide guess.
-- This adds the setting and the account id the provider needs to act on it.
--
-- -----------------------------------------------------------------------------
-- HOW THE TWO MODES MAP ONTO CASHFREE
-- -----------------------------------------------------------------------------
--
--   PLATFORM_COLLECT  Easy Split with real allocations. The customer pays once;
--                     Cashfree routes the stall's share to the stall's account
--                     and the commission to the platform's. Ledger AUTHORITATIVE
--                     — the platform's own account received the commission.
--
--   VENDOR_DIRECT     Easy Split with ONE allocation, the whole amount, to the
--                     stall. The platform takes nothing at payment time and
--                     invoices commission weekly or monthly instead.
--
-- Both go through one Cashfree integration, and that is the point. The
-- alternative reading of VENDOR_DIRECT — each stall holding its own Cashfree
-- merchant account with its own credentials — is what PRD §14.2's "platform not
-- in the flow" describes literally, and it would need per-vendor secrets, a
-- separate webhook per stall and a refund path the platform cannot execute.
-- Routing 100% through Easy Split gets the same commercial outcome (the stall
-- is paid in full, the platform bills later) with one integration.
--
-- THE CONSEQUENCE, STATED PLAINLY: in this implementation VENDOR_DIRECT funds
-- do pass through the platform's merchant account, so its ledger entries are
-- better evidenced than PRD §14.2's ADVISORY. The authority column is left
-- alone rather than quietly upgraded — that is a commercial and accounting
-- decision, not a schema one, and a migration is the wrong place to make it.

-- -----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO, AND WHY THAT IS THE HEADLINE
-- -----------------------------------------------------------------------------
-- It was drafted adding three things. Two of them already existed:
--
--   vendor.settlement_mode      migration 1, line 194 — nullable, exactly the
--                               "NULL means not configured" semantics wanted
--   payment.provider_order_ref  migration 1, line 604 — the provider's ORDER
--                               handle, already separate from its payment ref
--
-- Both `ADD COLUMN`s would have failed on `column already exists` and taken the
-- whole batch with them. The original schema had anticipated a real aggregator;
-- the only genuinely missing pieces were the payee identifier and one index.
--
-- Recording that here rather than deleting the evidence: the next person to
-- integrate a provider should read `schema.ts` before writing DDL, because this
-- schema is further ahead than it looks.

-- -----------------------------------------------------------------------------
-- The stall's Easy Split vendor id.
-- -----------------------------------------------------------------------------
-- Cashfree's own identifier for the payee, created through their vendor API and
-- carrying the bank account the money actually lands in. It is not a secret —
-- it appears in every split payload — but it IS the difference between paying
-- this stall and paying another one, so it is unique per Cashfree environment.
--
-- Nullable because a stall exists before it is onboarded to payouts, and can be
-- listed on the customer app for browsing while it cannot yet be paid.
ALTER TABLE vendor
  ADD COLUMN cashfree_vendor_id TEXT
    CONSTRAINT vendor_cashfree_id_shape CHECK (
      cashfree_vendor_id IS NULL
      OR (char_length(cashfree_vendor_id) BETWEEN 3 AND 100
          AND cashfree_vendor_id ~ '^[A-Za-z0-9_-]+$')
    );

COMMENT ON COLUMN vendor.cashfree_vendor_id IS
  'Cashfree Easy Split vendor id for this stall. The payee in every split payload. '
  'NULL until the stall is onboarded to payouts.';

-- Two stalls must never share a payout identity — that is money reaching the
-- wrong kitchen, and it would be invisible until somebody reconciled a bank
-- statement. Partial, so the many not-yet-onboarded stalls can all hold NULL.
CREATE UNIQUE INDEX vendor_cashfree_id_uq
  ON vendor (cashfree_vendor_id)
  WHERE cashfree_vendor_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- An index on the provider's order handle. The COLUMN already exists.
-- -----------------------------------------------------------------------------
-- `payment.provider_order_ref` has been there since migration 1 — the original
-- schema already separated the provider's ORDER handle from its PAYMENT handle,
-- which is exactly the distinction Cashfree needs (`cf_order_id` keys the split,
-- refund and settlement endpoints; the payment ref keys the payment).
--
-- This migration first tried to ADD it, which would have failed the entire
-- batch on `column already exists`. Only the lookup was actually missing: the
-- webhook arrives naming the order and has to find the payment row from it, and
-- without an index that is a sequential scan on every callback.
CREATE INDEX payment_provider_order_ref_idx
  ON payment (provider_order_ref)
  WHERE provider_order_ref IS NOT NULL;

-- migrate:down
-- The column is NOT dropped: migration 1 created it, so it is not ours to
-- remove. Only the index this migration added comes back out.
DROP INDEX IF EXISTS payment_provider_order_ref_idx;
DROP INDEX IF EXISTS vendor_cashfree_id_uq;
ALTER TABLE vendor DROP CONSTRAINT IF EXISTS vendor_cashfree_id_shape;
ALTER TABLE vendor DROP COLUMN IF EXISTS cashfree_vendor_id;
