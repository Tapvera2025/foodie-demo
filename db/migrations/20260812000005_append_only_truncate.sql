-- migrate:up
--
-- Close the TRUNCATE hole in the append-only guarantee.
--
-- Migration 20260810000002 added BEFORE UPDATE OR DELETE triggers so the ledger
-- could not be edited by anyone, superusers included. That was correct as far
-- as it went, and it did not go far enough:
--
--   TRUNCATE ledger_entry;
--
-- succeeds. TRUNCATE is a separate trigger event in Postgres — a BEFORE DELETE
-- trigger does not fire for it — and it removes every row at once. The strong
-- protection was in place against the careful mistake (a bad WHERE clause) and
-- absent against the catastrophic one.
--
-- This was found while building a way to clear seeded test data, which is worth
-- saying plainly: the escape hatch existed by accident before anyone designed
-- one deliberately. `scripts/reset-orders.ts` is the deliberate version — it
-- disables these triggers explicitly, in a transaction, refusing to run in
-- production. An intentional, logged, obviously-dangerous door is better than
-- an unnoticed gap.

CREATE OR REPLACE FUNCTION refuse_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; TRUNCATE is not permitted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          HINT = 'Development resets go through scripts/reset-orders.ts, which disables this deliberately.';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_no_truncate
  BEFORE TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER order_status_history_no_truncate
  BEFORE TRUNCATE ON order_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER processed_event_no_truncate
  BEFORE TRUNCATE ON processed_event
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

-- migrate:down
SELECT 'not implemented' AS note;
