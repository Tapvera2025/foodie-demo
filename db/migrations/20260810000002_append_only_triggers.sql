-- migrate:up
--
-- Make the append-only tables actually append-only.
--
-- WHY THIS MIGRATION EXISTS
--
-- PRD LED-01 says the ledger is "append-only, enforced by GRANT at the database
-- level, not by application discipline". The initial schema implemented that
-- with a DO block doing REVOKE UPDATE, DELETE ... FROM app_rw.
--
-- Running it against a real Postgres showed that guarantee was worth nothing:
--
--   1. The block is conditional on a role named `app_rw` existing. On a fresh
--      database it does not, so the REVOKEs were skipped entirely and the block
--      printed a NOTICE nobody reads.
--   2. Even with the role created, GRANTs do not restrain a superuser or the
--      table owner. Every developer connects as one, and plenty of small
--      deployments run the application as one too.
--
-- So the ledger was editable, and a constraint test caught it: "UPDATE on
-- ledger_entry is refused — the database ACCEPTED this. It must not."
--
-- A trigger has neither weakness. It fires for superusers, for the owner, and
-- for anyone connected through any role. Grants remain below as defence in
-- depth for the least-privilege setup, but the trigger is the guarantee.

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Corrections are new compensating entries, never edits. PRD LED-01.';
END $$ LANGUAGE plpgsql;

-- Statement-level: cheaper than per-row, and it also refuses an UPDATE that
-- would have matched zero rows, which is the correct answer to "may I edit
-- the ledger?" regardless of how many rows the WHERE clause happens to hit.

CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER order_status_history_append_only
  BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

-- These two may be updated (marking an event processed, acknowledging a
-- dispatch) but never deleted — deleting a processed_event row would let a
-- replayed webhook through, which is the whole idempotency guarantee.

CREATE TRIGGER processed_event_no_delete
  BEFORE DELETE ON processed_event
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER dispatch_attempt_no_delete
  BEFORE DELETE ON dispatch_attempt
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

-- Defence in depth. Unlike the original, this CREATES the role rather than
-- silently skipping when it is absent, so a least-privilege deployment gets
-- the grants without a manual step. NOLOGIN because credentials belong to the
-- deployment, not to a migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO app_rw';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw';

  EXECUTE 'REVOKE UPDATE, DELETE ON ledger_entry         FROM app_rw';
  EXECUTE 'REVOKE UPDATE, DELETE ON order_status_history FROM app_rw';
  EXECUTE 'REVOKE UPDATE, DELETE ON audit_log            FROM app_rw';
  EXECUTE 'REVOKE DELETE          ON processed_event     FROM app_rw';
  EXECUTE 'REVOKE DELETE          ON dispatch_attempt    FROM app_rw';
EXCEPTION
  -- A migration user without CREATEROLE is a legitimate production posture
  -- (managed Postgres often withholds it). Degrade to a warning rather than
  -- failing the deploy: the triggers above already hold the line, and this
  -- block is only the second lock on the same door.
  WHEN insufficient_privilege THEN
    RAISE WARNING 'skipped app_rw grants: % — append-only is still enforced by trigger', SQLERRM;
END $$;

-- migrate:down
-- Deliberately not implemented. Infra & Ops §6.3: never roll back a migration
-- on production to fix an application bug. Roll the application back instead.
SELECT 'refusing to make the ledger editable again' AS note;
