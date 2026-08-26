-- migrate:up
--
-- A stall asking for a carousel slot, and the platform answering.
--
-- ============================================================================
-- WHY THE GRANT NEEDED A WAY IN
-- ============================================================================
--
-- Migration 14 made `offer_uploads_enabled` the platform's decision, default
-- FALSE, which is right: the carousel is the first thing on the customer home
-- screen and a stall that could put itself there would take that space from
-- every other stall in the court.
--
-- But it left the stall with a closed door and no bell. The kitchen board said
-- "your stall does not have a slot — ask the food court office", and there was
-- no office to ask inside the product. Every route out was a phone call.
--
-- ============================================================================
-- TWO TIMESTAMPS, NOT ONE FLAG
-- ============================================================================
--
--   offer_slot_requested_at   the stall asked. NULL when nothing is pending.
--   offer_slot_decided_at     the platform last answered, either way.
--
-- A single `requested` boolean would collapse two states that must read
-- differently to the stall:
--
--   asked, nobody has looked          "waiting on the office"
--   asked, the office said no         "reviewed — ask again if things change"
--
-- Clearing the flag on a decline produces the second as the FIRST — the stall
-- sees the plain "you have no slot" screen again, concludes the request was
-- lost, and asks every week into what feels like silence. The decision has to
-- leave a mark even when the answer is no, or the product is quietly training
-- vendors to nag.
--
-- Granting is not recorded here. `offer_uploads_enabled` already says yes, and
-- a second column meaning the same thing is a second column that can disagree.

ALTER TABLE vendor ADD COLUMN offer_slot_requested_at TIMESTAMPTZ;
ALTER TABLE vendor ADD COLUMN offer_slot_decided_at   TIMESTAMPTZ;

-- A request that is pending on a stall that already HAS the slot is a
-- contradiction — there is nothing left to ask for. Enforced rather than left
-- to the endpoints, because two surfaces write these columns.
ALTER TABLE vendor
  ADD CONSTRAINT vendor_no_request_when_granted
  CHECK (NOT (offer_uploads_enabled AND offer_slot_requested_at IS NOT NULL));

-- Pending requests, for the console's queue. Partial, because the queue is
-- almost always a handful of rows against a table of every stall on the
-- platform, and the index should be the size of the question.
CREATE INDEX vendor_offer_slot_pending
  ON vendor (offer_slot_requested_at)
  WHERE offer_slot_requested_at IS NOT NULL;

COMMENT ON COLUMN vendor.offer_slot_requested_at IS
  'The stall asked for a carousel slot. NULL when nothing is pending.';
COMMENT ON COLUMN vendor.offer_slot_decided_at IS
  'When the platform last answered. Set on a decline too, so the stall is told.';

-- migrate:down
DROP INDEX IF EXISTS vendor_offer_slot_pending;
ALTER TABLE vendor DROP CONSTRAINT IF EXISTS vendor_no_request_when_granted;
ALTER TABLE vendor DROP COLUMN IF EXISTS offer_slot_decided_at;
ALTER TABLE vendor DROP COLUMN IF EXISTS offer_slot_requested_at;
