-- migrate:up
-- =============================================================================
-- THE STALL'S OWN RECOMMENDATION, KEPT SEPARATE FROM THE EARNED ONE
-- =============================================================================
--
-- `menu()` in discovery.controller.ts already badges a "Bestseller", and it
-- computes it from SUM(quantity) over the last seven days of non-rejected
-- lines. The comment there makes the case for that plainly:
--
--     "Every version of that badge worth shipping is a fact — a
--      vendor-editable 'featured' flag becomes a badge on everything within a
--      week, which is the same as a badge on nothing."
--
-- That argument is right, and it is an argument against overloading THAT
-- badge. It is not an argument against a stall having any say at all: a cook
-- knows which dish they would put in front of a first-time customer, and that
-- is real information a sales count cannot produce — a new dish has no
-- history, and the thing a stall is proud of is not always the thing that
-- sells most.
--
-- So this is a SECOND, DIFFERENTLY-LABELLED flag. "Bestseller" stays a
-- measurement. This is the stall's recommendation, and the customer app calls
-- it "Must try" so that nobody is being told a number exists when it does not.
--
-- -----------------------------------------------------------------------------
-- THE CAP IS THE WHOLE DESIGN
-- -----------------------------------------------------------------------------
--
-- A boolean with no limit becomes true for every row, for exactly the reason
-- quoted above, and then the badge conveys nothing and the filter returns the
-- entire menu. Three per stall is what keeps "must try" meaning "these ones".
--
-- It is NOT enforced here, and that is deliberate rather than an omission.
-- Postgres cannot express "at most three rows per vendor" as a constraint:
-- the vendor is two joins away (menu_item -> menu -> vendor), so a partial
-- unique index cannot reach it, and the only declarative options are a trigger
-- or a materialised counter — both of which put a product rule somewhere
-- nobody reading the endpoint would look.
--
-- The endpoint enforces it inside a transaction that takes `FOR UPDATE` on the
-- vendor row, which is the same mechanism `describe.controller.ts` uses to
-- reserve an AI generation credit. Two cooks tapping at once on two tablets
-- serialise on that lock, so the fourth pick is refused rather than racing in.
-- `tests/conformance/must-try.mjs` asserts the endpoint actually holds the
-- lock, because a cap enforced only in a UI is not enforced.

ALTER TABLE menu_item
  ADD COLUMN must_try BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN menu_item.must_try IS
  'The STALL''s own recommendation, set from the kitchen board. Distinct from '
  'the computed bestseller, which is derived from units sold and is never '
  'editable. Capped at 3 per vendor by the endpoint, which holds FOR UPDATE on '
  'the vendor row while counting.';

-- Partial, because the only question ever asked of this column is "which items
-- ARE flagged" — for the badge, for the filter, and for the cap count. Indexing
-- the false rows would index almost the whole table to answer nothing.
CREATE INDEX menu_item_must_try_idx
  ON menu_item (menu_id)
  WHERE must_try;

-- migrate:down
DROP INDEX IF EXISTS menu_item_must_try_idx;
ALTER TABLE menu_item DROP COLUMN IF EXISTS must_try;
