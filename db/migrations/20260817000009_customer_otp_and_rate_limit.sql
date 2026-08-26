-- migrate:up
--
-- Customer identity by mobile OTP, and the rate limiting without which the OTP
-- endpoint is a way for strangers to spend our SMS budget.
--
-- DR-0001 (docs/decisions/0001-customer-otp-at-add-to-cart.md) and PRD §11.2.
--
-- The prompt appears at add-to-cart: the customer has expressed intent and
-- invested almost nothing, so the interruption costs one item's worth of
-- momentum rather than a full basket's. Browsing stays anonymous.

-- ===========================================================================
-- 1. The customer becomes a real principal
-- ===========================================================================
--
-- `customer` has existed since the initial schema and has never been queried.
-- It now carries the verified phone number and is what `app_session.customer_id`
-- points at.

ALTER TABLE customer
  -- Bumping this kills every token the customer holds, the same revocation
  -- mechanism as staff and devices (AUTH-05). A blocklist would be a second
  -- system to keep consistent; a counter compared against a claim is one.
  ADD COLUMN token_version INT NOT NULL DEFAULT 1,
  ADD COLUMN last_seen_at  TIMESTAMPTZ;

-- E.164, because "9876543210", "+91 98765 43210" and "09876543210" are the
-- same customer and three different rows if the format is left to call sites.
-- Normalisation happens once, at the boundary, and this refuses anything else.
ALTER TABLE customer
  ADD CONSTRAINT customer_phone_e164
  CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');

CREATE UNIQUE INDEX customer_phone_uq ON customer (phone) WHERE phone IS NOT NULL;

-- ===========================================================================
-- 2. One-time codes
-- ===========================================================================
--
-- HASHED AT REST, and specifically keyed-hashed.
--
-- A six-digit code has 10^6 possibilities. An unkeyed hash — even a slow one —
-- is enumerable offline by anyone who reads this table: at 100ms per guess a
-- single code falls in under a day, and the attacker has the whole table. So
-- the hash is HMAC-SHA-256 under a server-side pepper derived from
-- AUTH_SIGNING_SEED. Without the seed the column is useless; with the seed you
-- already own the system.
--
-- This is the one place where a fast hash is the right answer and a slow one is
-- security theatre. See src/identity/otp.ts.

CREATE TABLE customer_otp (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          TEXT        NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash      TEXT        NOT NULL,
  -- Which browse session asked. Lets the code be bound to the session that
  -- requested it, so an OTP overheard elsewhere is not portable.
  app_session_id UUID        REFERENCES app_session(id) ON DELETE SET NULL,
  channel        TEXT        NOT NULL CHECK (channel IN ('SMS', 'WHATSAPP', 'CONSOLE')),
  attempts       INT         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts   INT         NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at     TIMESTAMPTZ NOT NULL,
  dispatched_at  TIMESTAMPTZ,
  dispatch_error TEXT,
  consumed_at    TIMESTAMPTZ,
  superseded_at  TIMESTAMPTZ,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A code cannot be both used and replaced.
  CONSTRAINT customer_otp_one_ending
    CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);

-- At most one live code per number, enforced by the database rather than by
-- the send handler remembering to supersede. Requesting a second code
-- invalidates the first — otherwise both work, and the window in which a
-- shoulder-surfed code is useful doubles with every resend.
--
-- The predicate is deliberately free of now(): a partial index cannot call a
-- volatile function, so expiry is checked at read time and "live" here means
-- "not yet consumed and not yet replaced".
CREATE UNIQUE INDEX customer_otp_one_live_per_phone
  ON customer_otp (phone)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

CREATE INDEX customer_otp_expiry_idx ON customer_otp (expires_at);

-- ===========================================================================
-- 3. Rate limiting
-- ===========================================================================
--
-- PRD §16.3: nothing was rate limited. The OTP send endpoint is where that
-- stops being advisable and becomes mandatory — it is unauthenticated and it
-- spends money per call.
--
-- WHY POSTGRES AND NOT REDIS
--
-- REDIS_URL is configured and no Redis client is installed, so "use Redis"
-- today means "write an in-memory limiter and call it Redis". An in-memory
-- limiter is correct on one replica and silently stops limiting on two — each
-- process counts its own share and the effective limit multiplies by the
-- replica count. Nothing errors. That is exactly the failure mode PRD §2.2
-- names, in the one place where the consequence is a bill.
--
-- A row per bucket per window costs one round trip on the limited endpoints,
-- which are the cheap ones. When Redis is genuinely wired, this table is the
-- fallback that keeps the guarantee true during the switch rather than the
-- thing that gets deleted first.

CREATE TABLE rate_limit_counter (
  -- 'otp.send:phone:+919876543210', 'otp.send:ip:203.0.113.7', 'qr.resolve:ip:...'
  bucket       TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INT         NOT NULL DEFAULT 0 CHECK (hits >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, window_start)
);

-- Old windows are dead weight; the sweeper deletes by this.
CREATE INDEX rate_limit_window_idx ON rate_limit_counter (window_start);

COMMENT ON TABLE rate_limit_counter IS
  'Fixed-window counters. PRD §16.3. Durable and correct across replicas, unlike '
  'an in-process limiter, which is why this is not a Map.';

-- ===========================================================================
-- 4. Sessions carry an identity once there is one
-- ===========================================================================
--
-- The session id does NOT change on authentication (DR-0001 §3). The cart hangs
-- off the session, and rotating the id at exactly the moment the customer has
-- just added their first item is how the cart disappears — the single most
-- likely way to make this change feel worse than no auth at all.

CREATE INDEX app_session_customer_idx ON app_session (customer_id)
  WHERE customer_id IS NOT NULL;

-- `order_customer_idx` is NOT created here. 20260810000001 line 512 already
-- built it, unconditionally, and a second CREATE INDEX under the same name
-- aborts the whole migration:
--
--     relation "order_customer_idx" already exists
--
-- Worth being precise about what went wrong, because the instinct is to add
-- IF NOT EXISTS and move on. That would have silently kept the OLD index and
-- discarded the partial one written here, leaving a migration that claims to
-- have created something it did not. The existing index is the better of the
-- two anyway — it covers rows where customer_id IS NULL, which the order
-- history query does not need but the reconciliation queries do.
--
-- The general rule: check for an existing index before adding one to a table
-- that has been through nine migrations.

-- migrate:down
SELECT 'not implemented' AS note;
