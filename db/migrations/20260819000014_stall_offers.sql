-- migrate:up
--
-- Offer banners: one image per stall, on the customer home carousel.
--
-- ============================================================================
-- THIS IS MARKETING, NOT MONEY
-- ============================================================================
--
-- There is no discount here and that is deliberate. `order.discount_paise`
-- already exists and `computeQuote` already subtracts it, so wiring a real
-- discount would be a short change — and it would force a decision nobody has
-- made: who pays for it. A vendor-funded discount reduces the vendor's
-- settlement; a platform-funded one is an unbounded liability without a spend
-- cap. Both need ledger and GST work.
--
-- So this column holds an IMAGE the stall put up about its own menu pricing,
-- and the checkout is untouched. If that ever changes, `discount_paise` is
-- where it goes, and the offer will need an amount, a cap, and a funder.
--
-- ============================================================================
-- WHY THE PLATFORM GRANTS THE SLOT AND THE STALL FILLS IT
-- ============================================================================
--
-- Two columns, controlled by two different parties, and neither can do the
-- other's half:
--
--   offer_uploads_enabled   the PLATFORM decides which stalls may appear in
--                           the carousel. Default FALSE.
--   offer_image_url         the STALL uploads its own artwork.
--
-- The carousel is the most prominent surface in the customer app — it is above
-- the fold on every visit, before any stall list. A stall that could put itself
-- there unilaterally would take that space from every other stall in the court,
-- and the first one to notice would take it permanently. Granting it per stall
-- is what makes it a thing the platform can sell, ration, or withdraw.
--
-- FALSE by default for the same reason: a new column that silently opts every
-- existing stall into the most valuable screen in the product would be a
-- decision made by a migration rather than by a person.

ALTER TABLE vendor ADD COLUMN offer_image_url       TEXT;
ALTER TABLE vendor ADD COLUMN offer_headline        TEXT;
ALTER TABLE vendor ADD COLUMN offer_uploads_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE vendor
  ADD CONSTRAINT vendor_offer_image_url_length
  CHECK (offer_image_url IS NULL OR length(offer_image_url) BETWEEN 1 AND 2048);

-- The headline is the image's ALT TEXT, not a caption.
--
-- An offer rendered only as artwork is invisible to a screen reader and to
-- anybody on a connection where the image never loads — which in a basement
-- food court is not rare. Short, because it has to be readable aloud in one
-- breath: "Momo I Am, 30% off up to 75 rupees".
ALTER TABLE vendor
  ADD CONSTRAINT vendor_offer_headline_length
  CHECK (offer_headline IS NULL OR length(trim(offer_headline)) BETWEEN 1 AND 80);

-- An image with no headline is an offer nobody can hear. Enforced rather than
-- left to the UI, because the UI that uploads it is not the UI that reads it.
ALTER TABLE vendor
  ADD CONSTRAINT vendor_offer_needs_headline
  CHECK (offer_image_url IS NULL OR offer_headline IS NOT NULL);

COMMENT ON COLUMN vendor.offer_image_url IS
  'Carousel artwork. Marketing only — it applies no discount at checkout.';
COMMENT ON COLUMN vendor.offer_uploads_enabled IS
  'Granted by the platform. FALSE means the stall cannot appear in the carousel.';

-- migrate:down
ALTER TABLE vendor DROP CONSTRAINT IF EXISTS vendor_offer_needs_headline;
ALTER TABLE vendor DROP CONSTRAINT IF EXISTS vendor_offer_headline_length;
ALTER TABLE vendor DROP CONSTRAINT IF EXISTS vendor_offer_image_url_length;
ALTER TABLE vendor DROP COLUMN IF EXISTS offer_uploads_enabled;
ALTER TABLE vendor DROP COLUMN IF EXISTS offer_headline;
ALTER TABLE vendor DROP COLUMN IF EXISTS offer_image_url;
