-- migrate:up
--
-- A NAME TO CALL AT THE COUNTER.
--
-- The platform has deliberately collected one thing about a customer — a phone
-- number (DR-0001) — on the reasoning that somebody buying a plate of noodles
-- will not fill in a form. That reasoning still holds for addresses, emails and
-- preferences. It does not hold for a first name, which is one field, typed
-- once, on a screen the customer is already on.
--
-- What it buys is the collection moment. A food court calls an order number
-- across a hall; a name alongside it is how the person at the counter knows
-- they are handing a bag to the right customer when two people both think
-- A-011 sounded like theirs.
--
-- WHY NULLABLE, AND WHY THAT IS NOT A HEDGE
--
-- Every customer created before this migration has no name and must keep
-- working. More importantly, the field stays OPTIONAL at the point of capture:
-- the one thing this journey cannot afford is another mandatory box between a
-- hungry person and their lunch. A customer who skips it gets exactly the
-- experience they get today.
--
-- WHY NOT `name`
--
-- `display_name` matches `platform_user.display_name`, which holds the same
-- kind of value for staff. Two columns meaning "what to call this person"
-- should not be spelled two ways.

ALTER TABLE customer ADD COLUMN display_name TEXT;

-- Bounded, and trimmed of the empty case.
--
-- 80 characters is generous for a name and short enough that the column cannot
-- be used as free-text storage. The length floor rejects a single space, which
-- is what a client sends when somebody tabs through the field — storing that
-- would produce a customer whose name renders as nothing and is not null, so
-- every read site would need to check both.
ALTER TABLE customer
  ADD CONSTRAINT customer_display_name_shape
  CHECK (display_name IS NULL OR (length(trim(display_name)) BETWEEN 1 AND 80));

COMMENT ON COLUMN customer.display_name IS
  'Optional. What to call the customer at collection. Never required to order.';

-- migrate:down
ALTER TABLE customer DROP CONSTRAINT IF EXISTS customer_display_name_shape;
ALTER TABLE customer DROP COLUMN IF EXISTS display_name;
