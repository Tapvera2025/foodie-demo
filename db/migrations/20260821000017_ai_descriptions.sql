-- migrate:up
-- =============================================================================
-- AI-WRITTEN DISH DESCRIPTIONS, AND THE METER THAT LIMITS THEM
-- =============================================================================
--
-- A kitchen can ask the platform to write a dish description for it. That call
-- costs the platform real money per request, so it is metered: two free
-- generations per stall, and after that the stall is told to contact the
-- platform for more.
--
-- -----------------------------------------------------------------------------
-- A LEDGER, NOT A COUNTER
-- -----------------------------------------------------------------------------
--
-- The obvious shape is `vendor.ai_generations_used INTEGER` and `UPDATE ... SET
-- used = used + 1`. It is smaller and it answers exactly one question, badly.
--
-- A counter cannot say WHEN the credits went, on WHICH dishes, through which
-- model, or whether the call that spent one actually produced anything. Every
-- one of those is a question somebody will ask the first time a stall says "we
-- never used those" — and with a counter the honest answer is "we do not know".
-- It also cannot be reconciled against a provider's bill, which is the thing
-- that eventually has to be paid.
--
-- One row per attempt makes usage a COUNT over rows, which is derived rather
-- than stored, so it cannot drift from the events that caused it.
--
-- -----------------------------------------------------------------------------
-- WHY FAILED ATTEMPTS ARE RECORDED BUT NOT CHARGED
-- -----------------------------------------------------------------------------
--
-- `outcome` distinguishes them. A generation that came back empty, timed out,
-- or exhausted both providers is written down — that is the record you need
-- when a kitchen reports the button "not working" — but only `'OK'` rows count
-- against the grant. Charging for a failure would mean a stall could lose both
-- free credits and still have no descriptions.
--
-- The partial index below is what makes that cheap: the balance query only ever
-- counts successful rows, so that is the only thing indexed.


-- -----------------------------------------------------------------------------
-- The grant, per stall.
-- -----------------------------------------------------------------------------
-- A column rather than a constant in the code, because "contact the platform
-- for more credits" has to have something for the platform to then change. Two
-- is the default the product asks for; raising it for one stall is an UPDATE,
-- not a deploy.
--
-- NOT NULL DEFAULT 2 backfills every existing stall with the free allowance,
-- which is the correct migration behaviour: nobody has generated anything yet,
-- so everybody starts with two.
ALTER TABLE vendor
  ADD COLUMN ai_description_credits INTEGER NOT NULL DEFAULT 2
    CONSTRAINT vendor_ai_credits_not_negative CHECK (ai_description_credits >= 0);

COMMENT ON COLUMN vendor.ai_description_credits IS
  'How many AI description generations this stall may spend in total. Default 2. '
  'Raised by the platform on request. Balance = this minus COUNT(ai_generation WHERE outcome = ''OK'').';

-- -----------------------------------------------------------------------------
-- The ledger.
-- -----------------------------------------------------------------------------
CREATE TABLE ai_generation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The stall that spent the credit. CASCADE because a deleted stall's usage
  -- history is meaningless on its own and must not pin the row.
  vendor_id       UUID NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,

  -- Which dish it was for.
  --
  -- NULLABLE, and SET NULL on delete, for two different reasons that happen to
  -- want the same column shape. A description can be generated for a dish that
  -- does not exist yet — the kitchen is filling in the "new item" form and has
  -- typed a name but not saved — and a dish deleted later must not erase the
  -- record that a credit was spent. The credit was spent either way.
  menu_item_id    UUID REFERENCES menu_item(id) ON DELETE SET NULL,

  -- What the kitchen typed in the name field. Kept because it is the whole
  -- input to the generation and the only way to explain a strange result later,
  -- and because `menu_item_id` may be null or may point at a since-renamed dish.
  dish_name       TEXT NOT NULL,

  -- 'GROK' or 'NEMOTRON'. Text rather than an enum: the fallback list is a
  -- commercial decision that will change more often than the schema should.
  provider        TEXT NOT NULL,

  -- The exact model string, which the provider name does not pin down. When a
  -- month's output quality changes, this is what says why.
  model           TEXT NOT NULL,

  -- 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT' | 'ALL_PROVIDERS_FAILED'
  -- Only 'OK' is charged. See the partial index below.
  outcome         TEXT NOT NULL,

  -- The generated text, for support and for reconciliation. Bounded, because an
  -- unbounded column filled by a remote model is an unbounded column filled by
  -- somebody else.
  generated_text  TEXT CONSTRAINT ai_generation_text_bounded CHECK (
                    generated_text IS NULL OR char_length(generated_text) <= 2000
                  ),

  -- How long the provider took, for spotting a degrading primary before the
  -- fallback rate makes it obvious.
  duration_ms     INTEGER,

  -- WHO asked. A stall's credits are spent by a person, and "who used our two
  -- generations" is the first question an owner asks. SET NULL rather than
  -- CASCADE: a revoked staff account must not delete the spend record.
  staff_user_id   UUID REFERENCES platform_user(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ai_generation IS
  'One row per AI description attempt, successful or not. Successful rows are '
  'the stall''s credit usage; failed rows are kept for support but not charged.';

-- The balance query, and nothing else, drives this index. Counting only the
-- charged rows keeps it small — failures are expected to outnumber successes
-- during a provider incident, and none of them belong in here.
CREATE INDEX ai_generation_charged_idx
  ON ai_generation (vendor_id)
  WHERE outcome = 'OK';

-- Support lookups: "what did this stall generate, most recent first".
CREATE INDEX ai_generation_vendor_recent_idx
  ON ai_generation (vendor_id, created_at DESC);

-- migrate:down
DROP INDEX IF EXISTS ai_generation_vendor_recent_idx;
DROP INDEX IF EXISTS ai_generation_charged_idx;
DROP TABLE IF EXISTS ai_generation;
ALTER TABLE vendor DROP CONSTRAINT IF EXISTS vendor_ai_credits_not_negative;
ALTER TABLE vendor DROP COLUMN IF EXISTS ai_description_credits;
