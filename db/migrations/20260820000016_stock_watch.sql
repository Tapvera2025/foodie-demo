-- migrate:up

-- ============================================================================
-- "TELL ME WHEN IT IS BACK"
-- ============================================================================
--
-- A diner searches for momos, finds them sold out, and leaves. Today that is
-- the end of it: the stall cooks another tray twenty minutes later and the one
-- person who definitely wanted them is the one person who does not find out.
--
-- WHY THIS IS A TABLE AND NOT A ROW IN `notification`
--
-- The obvious home is the existing notification ledger, and it does not fit.
-- Its dedupe index is `(order_id, event_key, event_version, tier)` and a
-- restock has no order. `order_id` is nullable, and in Postgres a UNIQUE index
-- treats every NULL as distinct — so the one thing that ledger exists to
-- guarantee, exactly-once delivery, silently stops holding for precisely the
-- rows that would live there. A watch carries its own `restocked_at`, and that
-- timestamp IS the dedupe.

CREATE TABLE stock_watch (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id   UUID NOT NULL REFERENCES menu_item(id) ON DELETE CASCADE,

  -- THE SESSION, NOT THE CUSTOMER, IS THE SUBJECT.
  --
  -- Most people who hit a sold-out dish have never verified a phone number —
  -- they scanned a poster ninety seconds ago. Keying on `customer_id` would
  -- make this feature available only to people who had already bought
  -- something, which is the opposite of who it is for.
  app_session_id UUID NOT NULL REFERENCES app_session(id) ON DELETE CASCADE,

  -- Recorded when it is known, so a future push or SMS tier has a recipient to
  -- send to. Nullable and expected to be null: see above.
  customer_id    UUID REFERENCES customer(id) ON DELETE SET NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A WATCH EXPIRES, AND THAT IS A FEATURE.
  --
  -- Someone who wanted a roll at lunch does not want to hear about it at nine
  -- the next morning, and a table of watches nobody ever clears is a table that
  -- only grows. The endpoint sets this from the session's own expiry, so the
  -- watch cannot outlive the browsing session that created it.
  expires_at     TIMESTAMPTZ NOT NULL,

  -- When the sweep saw the item become orderable again. NULL means still
  -- waiting. This is the exactly-once guard: the sweep only ever moves a row
  -- from NULL, and it does so in the same statement that reads it.
  restocked_at   TIMESTAMPTZ,

  -- When the customer was actually shown it. Distinct from `restocked_at`
  -- because they are different facts — "it came back" and "they know" — and
  -- collapsing them means a restock detected while the phone is in a pocket is
  -- indistinguishable from one the diner read and ignored.
  seen_at        TIMESTAMPTZ
);

-- ONE LIVE WATCH PER ITEM PER SESSION.
--
-- Tapping the button twice is not two requests, and without this a customer
-- who taps it, navigates away and taps it again gets told twice.
CREATE UNIQUE INDEX stock_watch_uq ON stock_watch (menu_item_id, app_session_id);

-- The sweep's question: which items is anybody still waiting on. Partial,
-- because that is a handful of rows against a table that accumulates every
-- watch ever created, and the index should be the size of the question.
CREATE INDEX stock_watch_pending_idx
  ON stock_watch (menu_item_id)
  WHERE restocked_at IS NULL;

-- The client's question: what is this session waiting on, and what came back.
CREATE INDEX stock_watch_session_idx ON stock_watch (app_session_id, created_at);

COMMENT ON TABLE stock_watch IS
  'A diner asked to be told when a sold-out item is orderable again.';
COMMENT ON COLUMN stock_watch.restocked_at IS
  'Set once by the sweep. The exactly-once guard — never cleared.';
COMMENT ON COLUMN stock_watch.seen_at IS
  'The customer was shown it. Separate from restocked_at on purpose.';

-- ============================================================================
-- THE KITCHEN'S SIDE: HOW LOW IS LOW
-- ============================================================================
--
-- Per item, because the number is a property of the dish rather than of the
-- stall. Three portions left is nearly out for a thali somebody cooks to order
-- and comfortable for a packet of chips.
--
-- NULL means "use the platform default", not "no warning". A column where the
-- absent value silently disables the feature is a column that disables the
-- feature for everyone on the day it ships, because every existing row is NULL.
ALTER TABLE menu_item ADD COLUMN low_stock_threshold INT;

ALTER TABLE menu_item
  ADD CONSTRAINT menu_item_low_stock_threshold_sane
  CHECK (low_stock_threshold IS NULL OR low_stock_threshold BETWEEN 1 AND 999);

COMMENT ON COLUMN menu_item.low_stock_threshold IS
  'Warn the kitchen at or below this many remaining. NULL uses the default.';

-- migrate:down
ALTER TABLE menu_item DROP CONSTRAINT IF EXISTS menu_item_low_stock_threshold_sane;
ALTER TABLE menu_item DROP COLUMN IF EXISTS low_stock_threshold;
DROP INDEX IF EXISTS stock_watch_session_idx;
DROP INDEX IF EXISTS stock_watch_pending_idx;
DROP INDEX IF EXISTS stock_watch_uq;
DROP TABLE IF EXISTS stock_watch;
