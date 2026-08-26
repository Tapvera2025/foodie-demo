-- migrate:up
--
-- Stall imagery: a cover photograph and a logo.
--
-- WHY THE VENDOR TABLE HAD NEITHER
--
-- `menu_item.image_url` has existed since the initial schema because a dish is
-- obviously a thing with a picture. The STALL was only ever a name and a list of
-- cuisine tags, which was fine while the stall list was a row of text — and is
-- not fine now that the card is mostly photograph.
--
-- TWO FIELDS, NOT ONE, BECAUSE THEY ARE DIFFERENT PICTURES
--
--   cover_image_url  the food. Wide, atmospheric, shot of a counter or a dish.
--                    It fills the top of the card and sells the stall.
--   logo_url         the brand mark. Square, usually on white, and it must stay
--                    legible at 44px overlapping the cover's bottom-left corner.
--
-- Collapsing them would mean either a logo stretched across a 16:9 band or a
-- photograph squashed into a 44px square. Every food-delivery app in India
-- carries both for this reason.
--
-- BOTH NULLABLE, AND THAT IS PERMANENT
--
-- A stall must be able to go live without a photographer. `assessVendorReadiness`
-- deliberately does not gain a blocker here: PRD §5.2's gate exists for things
-- that fail AFTER a customer has paid — no settlement account, no kitchen login.
-- A missing photograph fails nothing. The customer app renders a deterministic
-- gradient tile from the stall's name, which looks chosen rather than missing.
--
-- URLs, NOT BYTES
--
-- There is still no object storage. These hold a URL, which means in practice
-- only somebody comfortable hosting an image elsewhere can fill them — the same
-- limitation `menu_item.image_url` has always had. The columns land first so the
-- upload endpoint has somewhere to write when it exists.

ALTER TABLE vendor ADD COLUMN cover_image_url TEXT;
ALTER TABLE vendor ADD COLUMN logo_url        TEXT;

-- Length only. Deliberately NOT a URL-shape regex: Postgres would then be a
-- second, subtly different validator alongside the Zod `.url()` on the write
-- path, and the two would disagree on some edge case at the worst moment. The
-- database's job here is to refuse something absurd — a pasted essay, a base64
-- blob inlined by a well-meaning client — not to parse URLs.
ALTER TABLE vendor
  ADD CONSTRAINT vendor_cover_image_url_length
  CHECK (cover_image_url IS NULL OR length(cover_image_url) BETWEEN 1 AND 2048);

ALTER TABLE vendor
  ADD CONSTRAINT vendor_logo_url_length
  CHECK (logo_url IS NULL OR length(logo_url) BETWEEN 1 AND 2048);

COMMENT ON COLUMN vendor.cover_image_url IS
  'Wide photograph for the stall card and menu hero. Null renders a generated gradient.';
COMMENT ON COLUMN vendor.logo_url IS
  'Square brand mark, shown at 44px over the cover. Null renders the stall initial.';

-- migrate:down
ALTER TABLE vendor DROP CONSTRAINT IF EXISTS vendor_cover_image_url_length;
ALTER TABLE vendor DROP CONSTRAINT IF EXISTS vendor_logo_url_length;
ALTER TABLE vendor DROP COLUMN IF EXISTS cover_image_url;
ALTER TABLE vendor DROP COLUMN IF EXISTS logo_url;
