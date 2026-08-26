-- migrate:up
-- =============================================================================
-- THE ₹1 CONVENIENCE FEE, AS CONFIGURATION RATHER THAN CODE
-- =============================================================================
--
-- Two settlement modes decide who pays the platform:
--
--   PLATFORM_COLLECT  Cashfree collects, Easy Split routes the stall its money
--                     and the fee to us. The CUSTOMER pays the fee, per order.
--   VENDOR_DIRECT     The stall collects. We invoice commission weekly or
--                     monthly, and the customer pays no fee at all.
--
-- This inserts the first of those as a rule, not as an `if`. `fee-engine.ts`
-- already models FLAT_PER_ORDER with its own GST rate and a settlement-mode
-- allow-list, and `loadFeeRules` already resolves VENDOR over FOOD_COURT over
-- PLATFORM_DEFAULT — so a hard-coded ₹1 in the quote would have bypassed a
-- resolution order, a snapshot mechanism and an admin surface that all exist.
--
-- Being a row also means it can be superseded rather than edited. Every order
-- snapshots the rules that priced it into `order.fee_rule_snapshot`, so a
-- future change to the fee must not rewrite this row — it must close it with
-- `effective_to` and insert the next one. Refunds re-run the ORIGINAL rules
-- months later, and an edited row would silently re-price history.
--
-- -----------------------------------------------------------------------------
-- ₹1 PLUS GST, NOT ₹1 INCLUSIVE
-- -----------------------------------------------------------------------------
--
-- `amount_paise` is 100 and `tax_rate_bps` is 1800, so the customer pays ₹1.18
-- and the bill shows the fee and its tax on separate lines — which is what
-- `customerFeePaise` and `customerFeeTaxPaise` in the quote already are.
--
-- The alternative — ₹1 inclusive, backing out ₹0.85 + ₹0.15 — gives rounder
-- totals and was explicitly not chosen. It also cannot be expressed in this
-- table without a second "tax inclusive" flag, and one is not being added on
-- the strength of a preference.
--
-- -----------------------------------------------------------------------------
-- `allowed_modes` IS THE SAFETY, NOT THE `WHERE`
-- -----------------------------------------------------------------------------
--
-- Restricted to PLATFORM_COLLECT. Under VENDOR_DIRECT the money never touches
-- a platform account, so charging a customer a fee we cannot collect would put
-- a line on the bill that no ledger entry corresponds to. `assertRuleValid`
-- refuses the combination at configuration time and the quote refuses it at
-- checkout — this row simply never claims to apply there.

INSERT INTO fee_rule (
  scope,
  party,
  fee_type,
  amount_paise,
  tax_rate_bps,
  allowed_modes,
  version,
  effective_from
)
VALUES (
  'PLATFORM_DEFAULT',
  'CUSTOMER',
  'FLAT_PER_ORDER',
  100,      -- ₹1.00
  1800,     -- 18% GST on the fee itself, separate from tax on the food
  ARRAY['PLATFORM_COLLECT']::settlement_mode[],
  1,
  NOW()
)
-- Idempotent: the migration runner applies each file once, but this database
-- has been restored from dumps more than once during development and a second
-- identical default would make `loadFeeRules` pick between two rules of equal
-- specificity — non-deterministically.
ON CONFLICT DO NOTHING;

-- migrate:down
-- Removes only the row this migration added: matched on the full shape rather
-- than on id, because the id is generated. A hand-added CUSTOMER default with
-- different terms is somebody's deliberate configuration and is left alone.
DELETE FROM fee_rule
 WHERE scope = 'PLATFORM_DEFAULT'
   AND party = 'CUSTOMER'
   AND fee_type = 'FLAT_PER_ORDER'
   AND amount_paise = 100
   AND tax_rate_bps = 1800;
