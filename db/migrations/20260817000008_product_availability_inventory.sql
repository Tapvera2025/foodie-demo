-- migrate:up
--
-- PRD §6 — three concepts, three columns.
--
--   Product status   ACTIVE / INACTIVE                    does it exist on the menu
--   Availability     AVAILABLE / SOLD_OUT / TEMP_UNAVAIL  can it be ordered right now
--   Inventory mode   TRACKED / UNTRACKED                  is a count being kept
--
-- Before this migration the schema had `is_available BOOLEAN` and
-- `unavailable_until TIMESTAMPTZ` — roughly one and a half of the three, and no
-- inventory at all. The collapse matters because "we're out of chicken rolls
-- today" and "we no longer sell chicken rolls" were the same edit, which means
-- a vendor who ran out at 1pm had to delete the item and remember to recreate
-- it tomorrow. Nobody remembers.
--
-- This lands BEFORE the kitchen stock module rather than after it, because the
-- alternative is building that module on a boolean and then unpicking it from
-- the KDS, the customer menu, the order path and whatever reports exist by
-- then. PRD §6 says so explicitly and this is that migration.

CREATE TYPE product_status    AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE item_availability AS ENUM ('AVAILABLE', 'SOLD_OUT', 'TEMPORARILY_UNAVAILABLE');
CREATE TYPE inventory_mode    AS ENUM ('TRACKED', 'UNTRACKED');

-- ===========================================================================
-- 1. menu_item gains the three concepts
-- ===========================================================================

ALTER TABLE menu_item
  ADD COLUMN status         product_status    NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN availability   item_availability NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN inventory_mode inventory_mode    NOT NULL DEFAULT 'UNTRACKED';

-- `unavailable_until` becomes `available_from`, which is the same instant said
-- forwards. The old name forced a double negative at every call site —
-- `unavailable_until <= now()` meaning *available* — and read as if it applied
-- only to temporary closure. It applies to SOLD_OUT too: PRD KDS-STK-03 wants
-- an item that sold out at 1pm to come back by itself tomorrow, because a
-- vendor who has to re-enable forty items each morning will stop doing it and
-- the menu will quietly be wrong instead.
ALTER TABLE menu_item RENAME COLUMN unavailable_until TO available_from;

-- Backfill in specificity order: a future available_from is a temporary block
-- whatever the boolean said; otherwise the boolean decides.
UPDATE menu_item
   SET availability = CASE
     WHEN available_from IS NOT NULL AND available_from > now() THEN 'TEMPORARILY_UNAVAILABLE'
     WHEN is_available THEN 'AVAILABLE'
     ELSE 'SOLD_OUT'
   END::item_availability;

-- A lapsed block is not a block. Clearing these now means the constraint below
-- describes live state rather than accumulated residue.
UPDATE menu_item SET available_from = NULL
 WHERE available_from IS NOT NULL AND available_from <= now();

-- Dropped, not deprecated. Two sources of truth for one fact is how they
-- disagree, and the disagreement surfaces as a customer ordering something the
-- kitchen cannot make. PRD §2.2.
ALTER TABLE menu_item DROP COLUMN is_available;

ALTER TABLE menu_item
  ADD CONSTRAINT menu_item_available_from_matches_availability
  CHECK (
    (availability = 'AVAILABLE' AND available_from IS NULL)
    OR (availability <> 'AVAILABLE')
  );

COMMENT ON COLUMN menu_item.status IS
  'PRD §6. Does this item exist on the menu at all. Discontinuing is not the same act as running out.';
COMMENT ON COLUMN menu_item.availability IS
  'PRD §6. Can it be ordered right now. Cleared automatically once available_from passes.';
COMMENT ON COLUMN menu_item.inventory_mode IS
  'PRD §6. TRACKED means a per-day count exists in menu_item_stock and remaining is computed from confirmed orders.';

CREATE INDEX menu_item_orderable_idx ON menu_item (menu_id)
  WHERE status = 'ACTIVE' AND availability = 'AVAILABLE';

-- ===========================================================================
-- 2. Daily stock
-- ===========================================================================
--
-- One row per item per service day. `service_date` is the court's local date,
-- not UTC: a food court closes at 22:00 IST and an order placed at 23:30 IST
-- belongs to that day's count, not to the next one, which is what a UTC date
-- would say.

CREATE TABLE menu_item_stock (
  menu_item_id  UUID        NOT NULL REFERENCES menu_item(id) ON DELETE CASCADE,
  service_date  DATE        NOT NULL,
  daily_stock   INT         NOT NULL CHECK (daily_stock >= 0),
  set_by        UUID        REFERENCES platform_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (menu_item_id, service_date)
);

CREATE TRIGGER menu_item_stock_touch
  BEFORE UPDATE ON menu_item_stock
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Every time a count is set, why and by whom. Append-only, like everything else
-- that answers "who changed this and when" after an argument.
CREATE TABLE menu_item_stock_history (
  id            BIGSERIAL   PRIMARY KEY,
  menu_item_id  UUID        NOT NULL REFERENCES menu_item(id) ON DELETE CASCADE,
  service_date  DATE        NOT NULL,
  previous_stock INT,
  new_stock     INT         NOT NULL CHECK (new_stock >= 0),
  actor_type    actor_type  NOT NULL,
  actor_id      UUID,
  note          TEXT,
  correlation_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX menu_item_stock_history_item_idx
  ON menu_item_stock_history (menu_item_id, service_date, id);

CREATE TRIGGER menu_item_stock_history_append_only
  BEFORE UPDATE OR DELETE ON menu_item_stock_history
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

CREATE TRIGGER menu_item_stock_history_no_truncate
  BEFORE TRUNCATE ON menu_item_stock_history
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

-- ===========================================================================
-- 3. Remaining is COMPUTED, never stored
-- ===========================================================================
--
-- PRD §6.2:  remaining = daily_stock − confirmed_quantity
--
-- A stored counter and the orders that moved it are two records of one fact,
-- and they drift the first time a transaction dies between them. Deriving costs
-- a join and cannot be wrong.
--
-- WHAT COUNTS AS CONSUMED
--
-- Not the order's current status — its history. An order that was rejected and
-- has since become REFUNDED reads as REFUNDED today, and the ingredients went
-- back on the shelf when it was rejected, not when the money was returned. The
-- append-only history is the only place that distinction survives, which is
-- what PRD §7 means by "an order is reconstructable from its history alone".
--
--   consumed   = ever reached PAYMENT_CONFIRMED   (PRD §6.1: deduct on
--                confirmation, never on add-to-cart, or ten people holding the
--                last ten rolls in baskets sell out food nobody bought)
--   released   = ever reached REJECTED or CANCELLED (the kitchen never
--                committed, or the customer withdrew)
--
-- A refund AFTER collection does not return stock. The food was made and
-- handed over; the money coming back does not put it in the fridge.

CREATE INDEX osh_terminal_lookup_idx ON order_status_history (order_id)
  WHERE to_status IN ('PAYMENT_CONFIRMED', 'REJECTED', 'CANCELLED');

CREATE OR REPLACE VIEW v_menu_item_stock_remaining AS
SELECT
  s.menu_item_id,
  s.service_date,
  s.daily_stock,
  COALESCE(c.consumed, 0)::INT                       AS consumed,
  (s.daily_stock - COALESCE(c.consumed, 0))::INT     AS remaining
FROM menu_item_stock s
LEFT JOIN LATERAL (
  SELECT SUM(oi.quantity) AS consumed
  FROM order_item oi
  JOIN "order" o  ON o.id = oi.order_id
  JOIN food_court fc ON fc.id = o.food_court_id
  WHERE oi.menu_item_id = s.menu_item_id
    AND NOT oi.is_rejected
    AND (o.created_at AT TIME ZONE fc.timezone)::date = s.service_date
    AND EXISTS (
      SELECT 1 FROM order_status_history h
      WHERE h.order_id = o.id AND h.to_status = 'PAYMENT_CONFIRMED'
    )
    AND NOT EXISTS (
      SELECT 1 FROM order_status_history h
      WHERE h.order_id = o.id AND h.to_status IN ('REJECTED', 'CANCELLED')
    )
) c ON true;

COMMENT ON VIEW v_menu_item_stock_remaining IS
  'PRD §6.2. remaining = daily_stock - confirmed_quantity, computed from append-only '
  'order history so it cannot drift from the orders that produced it.';

-- Oversell detector. Unlike v_ledger_imbalance this is NOT required to be
-- empty: a race between two checkouts on the last portion can legitimately
-- produce one, and the honest answer is a rejection with a reason, not a lock
-- held across a payment redirect. It must be small, and someone must look.
CREATE OR REPLACE VIEW v_stock_oversold AS
SELECT r.*, mi.name, mi.menu_id
FROM v_menu_item_stock_remaining r
JOIN menu_item mi ON mi.id = r.menu_item_id
WHERE r.remaining < 0;

-- migrate:down
SELECT 'not implemented' AS note;
