-- migrate:up
--
-- TWO PARTIES SPLIT AN ORDER: THE VENDOR AND THE PLATFORM.
--
-- The commercial model changed. The platform is sold directly to vendors rather
-- than to a venue, so there is no court operator, no revenue share, and nobody
-- with the `OPERATOR` role. What survives is §14.1's founding constraint, which
-- this does not touch: the platform may charge the vendor, or the customer, or
-- both, or neither, and change its mind per court and per stall without a
-- deploy. Those are still `party = 'VENDOR'` and `party = 'CUSTOMER'`.
--
-- WHY A CHECK CONSTRAINT AND NOT A TYPE CHANGE
--
-- PostgreSQL cannot drop an enum label, and the same problem was solved the same
-- way for the retired `COMPLETED` order status and `SUCCESS` payment status —
-- errata E-007. The label stays and becomes unreachable.
--
-- The constraint goes on `fee_rule`, which is the SOURCE. An operator share can
-- only enter the ledger by being priced from a rule, so refusing the rule
-- refuses every entry that would have followed it. Putting it here rather than
-- on `ledger_entry` also means the mistake is caught when somebody configures
-- it, not when a customer pays.
--
-- Historical ledger rows are deliberately untouched. §14.6: nothing is ever
-- edited, corrections are new compensating entries — and an order priced last
-- month under a rule that existed then is not wrong just because the rule is
-- gone. `ledger_entry` therefore keeps accepting the label so old orders can
-- still be refunded and reconciled.

-- ORDER MATTERS, AND THE FIRST VERSION OF THIS FILE HAD IT BACKWARDS.
--
-- The constraint was added first and the rows deleted after, which applies
-- cleanly to an empty database and fails on every database that has ever been
-- seeded: `check constraint ... is violated by some row`. A migration that only
-- works where there is no data is one that works in CI and fails in production,
-- which is the wrong way round.
--
-- Clear the rows the constraint forbids, THEN forbid them.
--
-- Deleting rather than deactivating: the seeded operator share was never a real
-- commercial term, and a deactivated rule is one somebody re-enables.
DELETE FROM fee_rule WHERE party = 'OPERATOR';

ALTER TABLE fee_rule
  ADD CONSTRAINT fee_rule_party_not_operator
  CHECK (party <> 'OPERATOR');

COMMENT ON CONSTRAINT fee_rule_party_not_operator ON fee_rule IS
  'Two parties split an order: VENDOR and CUSTOMER. There is no court operator '
  'to pay — the product is sold direct to vendors. A rule allocating money to a '
  'party with no settlement account is not a pricing decision, it is a leak.';


-- migrate:down
ALTER TABLE fee_rule DROP CONSTRAINT IF EXISTS fee_rule_party_not_operator;
