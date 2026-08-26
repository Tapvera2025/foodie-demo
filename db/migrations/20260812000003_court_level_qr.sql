-- migrate:up
--
-- The QR code belongs to the FOOD COURT, not to a table.
--
-- WHY THIS CHANGES
--
-- The original model gave every table its own QR token and made
-- `order.court_table_id` NOT NULL. That assumed a restaurant, where tables are
-- numbered, owned, and stay put so that food can be brought to them.
--
-- A food court is not that. The seating is shared between every stall, chairs
-- and tables get dragged around all day, and no vendor owns any of it — so
-- nobody is responsible for maintaining a sticker per table, and a token that
-- moves to a different corner of the hall is worse than no token. There is
-- also no table service to justify it: the customer collects from the counter
-- when their number is called.
--
-- So the identity that matters is "which food court am I standing in", which a
-- poster, a standee or a sticker on each stall front answers perfectly well.
-- The order number, not a table, is how a customer is identified at collection.
--
-- WHAT IS KEPT
--
-- `court_table` survives and both foreign keys merely become nullable rather
-- than being dropped. Some venues genuinely do have numbered seating and may
-- want table service later, and throwing away a modelled concept to re-derive
-- it in six months is expensive. Unused-and-nullable costs one column; deleted
-- and rebuilt costs a migration against live order history.

ALTER TABLE food_court ADD COLUMN qr_token TEXT;

-- Same uniqueness guarantee the table-level token had. Partial, because
-- existing rows are NULL until a token is issued and NULL is not a duplicate.
CREATE UNIQUE INDEX food_court_qr_token_uq ON food_court (qr_token)
  WHERE qr_token IS NOT NULL;

-- A session is now "someone is in this food court", and may or may not know
-- which table they are sitting at.
ALTER TABLE app_session ALTER COLUMN court_table_id DROP NOT NULL;

-- An order no longer needs a table. It needs a vendor to make it and a number
-- to call out.
ALTER TABLE "order" ALTER COLUMN court_table_id DROP NOT NULL;

COMMENT ON COLUMN food_court.qr_token IS
  'The scannable identity of this court. Printed on posters and stall fronts.';
COMMENT ON COLUMN "order".court_table_id IS
  'Optional. Null for counter collection, which is the normal case in a food court.';

-- migrate:down
-- Not implemented. Restoring NOT NULL would fail against any order placed
-- without a table, which is every order under the corrected model.
SELECT 'refusing to require a table again' AS note;
