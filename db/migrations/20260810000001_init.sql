-- migrate:up
-- Initial schema. Identical to the authoritative schema.sql shipped with
-- PRD v5.2 §18. Plain SQL because it contains triggers, DO blocks, generated
-- columns, partial indexes, invariant views and GRANT/REVOKE that no ORM
-- migration DSL can express. See docs/tech/data.md.

-- =====================================================================
-- Food Court QR Ordering Platform — PostgreSQL schema
-- Companion to PRD v5.1 §18 and Technical Design Document §3
-- Target: PostgreSQL 16+
--
-- CONVENTIONS
--   * All money is BIGINT paise. There is no FLOAT/REAL/DOUBLE anywhere.
--   * All timestamps are TIMESTAMPTZ, stored UTC.
--   * Provider timestamps are stored separately from platform timestamps
--     and are never merged (PRD §29, clock-skew row).
--   * ledger_entry and order_status_history are append-only, enforced by
--     GRANT at the end of this file, not by application discipline.
--   * Snapshot columns (fee_rule_snapshot, settlement_mode_snapshot,
--     price_paise_snapshot ...) are immutable after INSERT — enforced by
--     trigger, see §"IMMUTABILITY GUARDS".
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive identifiers

-- =====================================================================
-- 1. ENUMS  (PRD §9.1, §12.2, §13, §18)
-- =====================================================================

CREATE TYPE settlement_mode AS ENUM ('PLATFORM_COLLECT', 'VENDOR_DIRECT');

CREATE TYPE order_status AS ENUM (
  'CREATED',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'DISPATCHED',
  'ACKNOWLEDGED',
  'PREPARING',
  'READY',
  'COMPLETED',
  'PAYMENT_FAILED',
  'DISPATCH_FAILED',
  'REJECTED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
  'REFUND_FAILED',
  'RECONCILIATION_REQUIRED'
);

CREATE TYPE payment_status AS ENUM (
  'INITIATED','PENDING','SUCCESS','FAILED',
  'REFUND_PENDING','REFUNDED','REFUND_FAILED','RECONCILIATION_REQUIRED'
);

CREATE TYPE refund_status AS ENUM (
  'REQUESTED','PENDING','SUCCEEDED','FAILED','ABANDONED'
);

CREATE TYPE refund_kind AS ENUM ('FULL','PARTIAL');

CREATE TYPE dispatch_target AS ENUM ('KDS','PRINTER','POS');

CREATE TYPE dispatch_outcome AS ENUM ('SENT','ACKNOWLEDGED','FAILED','TIMED_OUT');

CREATE TYPE ledger_authority AS ENUM ('AUTHORITATIVE','ADVISORY');

CREATE TYPE ledger_direction AS ENUM ('DEBIT','CREDIT');

-- Ledger entry catalogue. See TDD §8 for the double-entry worked examples.
CREATE TYPE ledger_entry_type AS ENUM (
  'GROSS_ORDER_VALUE',
  'FOOD_TAX',
  'CUSTOMER_PLATFORM_FEE',
  'CUSTOMER_FEE_TAX',
  'VENDOR_COMMISSION',
  'VENDOR_COMMISSION_TAX',
  'OPERATOR_SHARE',
  'OPERATOR_SHARE_TAX',
  'PLATFORM_TAX_RESERVE',        -- GST s.9(5) reserve, PRD §4.7
  'PROVIDER_FEE',
  'VENDOR_NET_PAYABLE',
  'REFUND',
  'REFUND_REVERSAL_VENDOR',
  'PLATFORM_CREDIT_ISSUED',
  'PLATFORM_CREDIT_CONSUMED',
  'PLATFORM_CREDIT_EXPIRED',
  'ADJUSTMENT'
);

CREATE TYPE fee_party AS ENUM ('CUSTOMER','VENDOR','OPERATOR');

CREATE TYPE fee_type AS ENUM ('PERCENTAGE','FLAT_PER_ORDER','SUBSCRIPTION_MONTHLY');

CREATE TYPE fee_scope AS ENUM ('PLATFORM_DEFAULT','FOOD_COURT','VENDOR');

CREATE TYPE actor_type AS ENUM (
  'CUSTOMER','VENDOR_USER','MANAGER','PLATFORM_OPS','PLATFORM_FINANCE',
  'SUPER_ADMIN','SYSTEM','PROVIDER_WEBHOOK','POS_WEBHOOK'
);

CREATE TYPE credit_status AS ENUM ('ISSUED','CONSUMED','EXPIRED','VOIDED');

CREATE TYPE reconciliation_state AS ENUM ('OPEN','INVESTIGATING','RESOLVED','WRITTEN_OFF');

CREATE TYPE reconciliation_kind AS ENUM (
  'PROVIDER_TXN_NO_ORDER',       -- customer charged, no order  (PRD §28.4)
  'ORDER_NO_PROVIDER_TXN',
  'AMOUNT_MISMATCH',
  'REFUND_UNCONFIRMED',
  'POS_STATE_DIVERGENCE',
  'SPLIT_MISMATCH'
);

CREATE TYPE notification_tier AS ENUM (
  'WEBSOCKET','WAKE_LOCK','WEB_PUSH','WHATSAPP','SMS','DISPLAY_BOARD'
);

CREATE TYPE notification_status AS ENUM (
  'QUEUED','SENT','DELIVERED','FAILED','SKIPPED','NOT_APPLICABLE'
);

CREATE TYPE entity_status AS ENUM ('DRAFT','ACTIVE','SUSPENDED','INACTIVE');

CREATE TYPE device_kind AS ENUM ('KDS_TABLET','THERMAL_PRINTER','DISPLAY_BOARD');

-- Fixed rejection reason list (PRD KDS-REJ-02). Free text is a separate column.
CREATE TYPE rejection_reason AS ENUM (
  'ITEM_OUT_OF_STOCK',
  'KITCHEN_OVERLOADED',
  'EQUIPMENT_FAILURE',
  'VENDOR_CLOSING',
  'INGREDIENT_UNAVAILABLE',
  'PRICE_OR_MENU_ERROR',
  'CUSTOMER_REQUEST',
  'DUPLICATE_ORDER',
  'OTHER'
);

CREATE TYPE menu_source_type AS ENUM ('PLATFORM','POS_PETPOOJA','POS_OTHER');

CREATE TYPE integration_health AS ENUM ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN');


-- =====================================================================
-- 2. TENANCY:  food courts, tables, devices
-- =====================================================================

CREATE TABLE food_court (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  city              TEXT        NOT NULL,
  address           TEXT,
  timezone          TEXT        NOT NULL DEFAULT 'Asia/Kolkata',
  operating_hours   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  config            JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- see TDD §15 config inventory
  status            entity_status NOT NULL DEFAULT 'DRAFT',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE court_table (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  food_court_id     UUID        NOT NULL REFERENCES food_court(id) ON DELETE RESTRICT,
  label             TEXT        NOT NULL,          -- human-readable, e.g. "A12"
  qr_token          TEXT        NOT NULL,          -- opaque 128-bit, base62. PRD CUS-QR-01
  status            entity_status NOT NULL DEFAULT 'ACTIVE',
  deactivated_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT court_table_label_uq UNIQUE (food_court_id, label),
  CONSTRAINT qr_token_len CHECK (char_length(qr_token) BETWEEN 22 AND 64)
);

-- One active token per table; historical tokens are retained but not reusable.
CREATE UNIQUE INDEX court_table_qr_token_uq ON court_table (qr_token);
CREATE INDEX court_table_court_idx ON court_table (food_court_id) WHERE status = 'ACTIVE';


-- =====================================================================
-- 3. VENDORS AND USERS
-- =====================================================================

CREATE TABLE vendor (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  food_court_id          UUID        NOT NULL REFERENCES food_court(id) ON DELETE RESTRICT,
  name                   TEXT        NOT NULL,
  legal_name             TEXT,
  cuisine                TEXT[]      NOT NULL DEFAULT '{}',
  status                 entity_status NOT NULL DEFAULT 'DRAFT',

  -- PRD §4: money-flow mode. NOT NULL for any ACTIVE vendor (see check below).
  settlement_mode        settlement_mode,

  -- KYC (PRD VEN-ONB-05). Required for PLATFORM_COLLECT activation.
  pan                    TEXT,
  gstin                  TEXT,
  fssai_licence          TEXT,
  bank_account_ref       TEXT,        -- token/reference, never raw account number
  kyc_completed_at       TIMESTAMPTZ,
  provider_linked_account_id TEXT,    -- PA sub-merchant id (Mode A)

  operating_hours        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  temp_closed_until      TIMESTAMPTZ,
  estimated_prep_minutes INT         NOT NULL DEFAULT 10 CHECK (estimated_prep_minutes BETWEEN 1 AND 180),

  -- Device health (PRD §11.2). Availability is derived, never stored as truth.
  kds_last_heartbeat_at  TIMESTAMPTZ,
  dispatch_blocked_at    TIMESTAMPTZ,        -- set by escalation ladder at 90s

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vendor_active_needs_mode
    CHECK (status <> 'ACTIVE' OR settlement_mode IS NOT NULL),
  CONSTRAINT vendor_platform_collect_needs_linked_account
    CHECK (status <> 'ACTIVE'
           OR settlement_mode <> 'PLATFORM_COLLECT'
           OR provider_linked_account_id IS NOT NULL)
);

CREATE INDEX vendor_court_idx ON vendor (food_court_id, status);
CREATE INDEX vendor_heartbeat_idx ON vendor (kds_last_heartbeat_at)
  WHERE status = 'ACTIVE';

CREATE TABLE platform_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE,
  phone         TEXT,
  display_name  TEXT NOT NULL,
  password_hash TEXT,
  status        entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Role assignment is always scoped to a tenant. A user with no row here
-- can see nothing. See TDD §14 for the permission matrix.
CREATE TABLE user_role_assignment (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES platform_user(id) ON DELETE CASCADE,
  role            actor_type NOT NULL,
  food_court_id   UUID REFERENCES food_court(id) ON DELETE CASCADE,
  vendor_id       UUID REFERENCES vendor(id) ON DELETE CASCADE,
  status          entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT role_scope_valid CHECK (
    (role = 'SUPER_ADMIN'       AND food_court_id IS NULL AND vendor_id IS NULL) OR
    (role IN ('PLATFORM_OPS','PLATFORM_FINANCE') AND vendor_id IS NULL)          OR
    (role = 'MANAGER'           AND food_court_id IS NOT NULL AND vendor_id IS NULL) OR
    (role = 'VENDOR_USER'       AND vendor_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX user_role_uq
  ON user_role_assignment (user_id, role, COALESCE(food_court_id,'00000000-0000-0000-0000-000000000000'::uuid),
                           COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE device (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id         UUID REFERENCES vendor(id) ON DELETE CASCADE,
  food_court_id     UUID NOT NULL REFERENCES food_court(id) ON DELETE CASCADE,
  kind              device_kind NOT NULL,
  label             TEXT NOT NULL,
  secret_hash       TEXT NOT NULL,          -- device auth, PRD §25
  last_heartbeat_at TIMESTAMPTZ,
  app_version       TEXT,
  status            entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_vendor_required CHECK (kind = 'DISPLAY_BOARD' OR vendor_id IS NOT NULL)
);

CREATE INDEX device_vendor_idx ON device (vendor_id, kind) WHERE status = 'ACTIVE';


-- =====================================================================
-- 4. CUSTOMERS AND SESSIONS
-- =====================================================================

CREATE TABLE customer (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             TEXT UNIQUE,             -- E.164. Unverified by default (PRD §8.2)
  phone_verified_at TIMESTAMPTZ,             -- NULL in pilot; payment is implicit verification
  whatsapp_opt_in_at TIMESTAMPTZ,
  whatsapp_consent_version TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE TABLE app_session (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID REFERENCES customer(id) ON DELETE SET NULL,
  food_court_id    UUID NOT NULL REFERENCES food_court(id) ON DELETE RESTRICT,
  court_table_id   UUID NOT NULL REFERENCES court_table(id) ON DELETE RESTRICT,
  active_vendor_id UUID REFERENCES vendor(id) ON DELETE SET NULL,
  device_fingerprint TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);

CREATE INDEX session_table_idx ON app_session (court_table_id, expires_at DESC);
CREATE INDEX session_customer_idx ON app_session (customer_id);


-- =====================================================================
-- 5. MENU
-- =====================================================================

CREATE TABLE menu (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id      UUID NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  source_type    menu_source_type NOT NULL DEFAULT 'PLATFORM',
  source_version TEXT,
  synced_at      TIMESTAMPTZ,
  is_stale       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX menu_vendor_uq ON menu (vendor_id);

CREATE TABLE menu_category (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id     UUID NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INT  NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX menu_category_menu_idx ON menu_category (menu_id, sort_order);

CREATE TABLE menu_item (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id           UUID NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
  menu_category_id  UUID NOT NULL REFERENCES menu_category(id) ON DELETE CASCADE,
  external_item_id  TEXT,                                   -- POS id where integrated
  name              TEXT    NOT NULL,
  description       TEXT,
  base_price_paise  BIGINT  NOT NULL CHECK (base_price_paise >= 0),
  tax_rate_bps      INT     NOT NULL DEFAULT 500 CHECK (tax_rate_bps BETWEEN 0 AND 10000), -- basis points
  image_url         TEXT,
  dietary_flags     TEXT[]  NOT NULL DEFAULT '{}',           -- VEG, NON_VEG, EGG, JAIN
  is_available      BOOLEAN NOT NULL DEFAULT true,
  unavailable_until TIMESTAMPTZ,                             -- auto-clear next service day
  sort_order        INT     NOT NULL DEFAULT 0,
  -- Variant groups and add-on groups with min/max selection rules (PRD CUS-MENU-02).
  -- Shape documented in TDD §5.2 and openapi.yaml#/components/schemas/OptionGroup
  variant_groups    JSONB   NOT NULL DEFAULT '[]'::jsonb,
  addon_groups      JSONB   NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX menu_item_menu_idx ON menu_item (menu_id, menu_category_id, sort_order);
CREATE UNIQUE INDEX menu_item_external_uq ON menu_item (menu_id, external_item_id)
  WHERE external_item_id IS NOT NULL;


-- =====================================================================
-- 6. CART   (PRD CUS-CART-01: one vendor per cart, enforced structurally)
-- =====================================================================

CREATE TABLE cart (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_session_id    UUID NOT NULL REFERENCES app_session(id) ON DELETE CASCADE,
  vendor_id         UUID NOT NULL REFERENCES vendor(id) ON DELETE RESTRICT,
  pricing_snapshot  JSONB,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open cart per session. Changing vendor replaces the cart, it never mixes.
CREATE UNIQUE INDEX cart_one_per_session ON cart (app_session_id);

CREATE TABLE cart_item (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id         UUID NOT NULL REFERENCES cart(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES menu_item(id) ON DELETE RESTRICT,
  vendor_id       UUID NOT NULL REFERENCES vendor(id) ON DELETE RESTRICT,
  quantity        INT  NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  selected_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  instructions    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cart_item_cart_idx ON cart_item (cart_id);

-- Structural guarantee that every item in a cart belongs to the cart's vendor.
CREATE OR REPLACE FUNCTION assert_cart_single_vendor() RETURNS TRIGGER AS $$
DECLARE cart_vendor UUID;
BEGIN
  SELECT vendor_id INTO cart_vendor FROM cart WHERE id = NEW.cart_id;
  IF cart_vendor IS DISTINCT FROM NEW.vendor_id THEN
    RAISE EXCEPTION 'cart % is bound to vendor %, cannot add item for vendor %',
      NEW.cart_id, cart_vendor, NEW.vendor_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER cart_item_single_vendor
  BEFORE INSERT OR UPDATE ON cart_item
  FOR EACH ROW EXECUTE FUNCTION assert_cart_single_vendor();


-- =====================================================================
-- 7. FEE RULES   (PRD §13, three parties, versioned)
-- =====================================================================

CREATE TABLE fee_rule (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             fee_scope NOT NULL,
  food_court_id     UUID REFERENCES food_court(id) ON DELETE CASCADE,
  vendor_id         UUID REFERENCES vendor(id) ON DELETE CASCADE,
  party             fee_party NOT NULL,
  fee_type          fee_type  NOT NULL,
  rate_bps          INT     CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  amount_paise      BIGINT  CHECK (amount_paise IS NULL OR amount_paise >= 0),
  min_floor_paise   BIGINT  NOT NULL DEFAULT 0 CHECK (min_floor_paise >= 0),
  max_cap_paise     BIGINT  CHECK (max_cap_paise IS NULL OR max_cap_paise >= 0),
  tax_rate_bps      INT     NOT NULL DEFAULT 1800 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  -- Modes this rule is legal in. PRD PAY-MODE-05 rejects invalid pairs at config time.
  allowed_modes     settlement_mode[] NOT NULL DEFAULT ARRAY['PLATFORM_COLLECT']::settlement_mode[],
  version           INT     NOT NULL DEFAULT 1,
  effective_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to      TIMESTAMPTZ,
  created_by        UUID REFERENCES platform_user(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fee_rule_scope_target CHECK (
    (scope = 'PLATFORM_DEFAULT' AND food_court_id IS NULL AND vendor_id IS NULL) OR
    (scope = 'FOOD_COURT'       AND food_court_id IS NOT NULL AND vendor_id IS NULL) OR
    (scope = 'VENDOR'           AND vendor_id IS NOT NULL)
  ),
  CONSTRAINT fee_rule_value_present CHECK (
    (fee_type = 'PERCENTAGE'          AND rate_bps IS NOT NULL) OR
    (fee_type IN ('FLAT_PER_ORDER','SUBSCRIPTION_MONTHLY') AND amount_paise IS NOT NULL)
  ),
  CONSTRAINT fee_rule_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX fee_rule_lookup_idx
  ON fee_rule (party, scope, vendor_id, food_court_id, effective_from DESC);


-- =====================================================================
-- 8. ORDERS
-- =====================================================================

CREATE TABLE "order" (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_order_number      TEXT        NOT NULL,   -- short, human-callable e.g. "A-412"
  app_session_id           UUID        REFERENCES app_session(id) ON DELETE SET NULL,
  customer_id              UUID        REFERENCES customer(id) ON DELETE SET NULL,
  food_court_id            UUID        NOT NULL REFERENCES food_court(id) ON DELETE RESTRICT,
  vendor_id                UUID        NOT NULL REFERENCES vendor(id) ON DELETE RESTRICT,
  court_table_id           UUID        NOT NULL REFERENCES court_table(id) ON DELETE RESTRICT,

  status                   order_status NOT NULL DEFAULT 'CREATED',

  -- PRD PAY-MODE-03 / FEE-03: snapshots. Immutable after insert.
  settlement_mode_snapshot settlement_mode NOT NULL,
  fee_rule_snapshot        JSONB       NOT NULL,
  tax_model_snapshot       JSONB       NOT NULL,   -- incl. the s.9(5) determination in force

  -- Money. All paise. See TDD §5 for the computation order.
  subtotal_paise           BIGINT      NOT NULL CHECK (subtotal_paise >= 0),
  food_tax_paise           BIGINT      NOT NULL DEFAULT 0 CHECK (food_tax_paise >= 0),
  customer_fee_paise       BIGINT      NOT NULL DEFAULT 0 CHECK (customer_fee_paise >= 0),
  customer_fee_tax_paise   BIGINT      NOT NULL DEFAULT 0 CHECK (customer_fee_tax_paise >= 0),
  discount_paise           BIGINT      NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  total_payable_paise      BIGINT      NOT NULL CHECK (total_payable_paise >= 0),
  vendor_commission_paise  BIGINT      NOT NULL DEFAULT 0 CHECK (vendor_commission_paise >= 0),
  operator_share_paise     BIGINT      NOT NULL DEFAULT 0 CHECK (operator_share_paise >= 0),
  platform_tax_reserve_paise BIGINT    NOT NULL DEFAULT 0 CHECK (platform_tax_reserve_paise >= 0),
  vendor_net_paise         BIGINT      NOT NULL DEFAULT 0 CHECK (vendor_net_paise >= 0),

  idempotency_key          TEXT        NOT NULL,   -- PRD API-01. The critical constraint.
  correlation_id           TEXT        NOT NULL,
  rejection_reason         rejection_reason,
  rejection_note           TEXT,
  customer_phone_snapshot  TEXT,
  payer_reference          TEXT,                   -- from provider; PRD CUS-ID-03

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_confirmed_at     TIMESTAMPTZ,
  dispatched_at            TIMESTAMPTZ,
  acknowledged_at          TIMESTAMPTZ,
  preparing_at             TIMESTAMPTZ,
  ready_at                 TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  terminal_at              TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT order_total_consistent CHECK (
    total_payable_paise =
      subtotal_paise + food_tax_paise + customer_fee_paise + customer_fee_tax_paise - discount_paise
  ),
  CONSTRAINT order_rejection_reason_required CHECK (
    status <> 'REJECTED' OR rejection_reason IS NOT NULL
  )
);

-- THE most important constraint in the database (PRD §18.3).
CREATE UNIQUE INDEX order_idempotency_uq ON "order" (idempotency_key);
CREATE UNIQUE INDEX order_public_number_uq ON "order" (food_court_id, public_order_number);
CREATE INDEX order_vendor_status_idx ON "order" (vendor_id, status, created_at DESC);
CREATE INDEX order_court_created_idx ON "order" (food_court_id, created_at DESC);
CREATE INDEX order_customer_idx ON "order" (customer_id, created_at DESC);
-- Hot path: the KDS queue and the escalation sweeper.
CREATE INDEX order_live_idx ON "order" (vendor_id, created_at)
  WHERE status IN ('DISPATCHED','ACKNOWLEDGED','PREPARING','READY');
CREATE INDEX order_unacked_idx ON "order" (dispatched_at)
  WHERE status = 'DISPATCHED';

CREATE TABLE order_item (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              UUID   NOT NULL REFERENCES "order"(id) ON DELETE RESTRICT,
  menu_item_id          UUID   REFERENCES menu_item(id) ON DELETE SET NULL,
  external_item_id      TEXT,
  name_snapshot         TEXT   NOT NULL,
  unit_price_paise_snapshot BIGINT NOT NULL CHECK (unit_price_paise_snapshot >= 0),
  quantity              INT    NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  options_snapshot      JSONB  NOT NULL DEFAULT '[]'::jsonb,
  options_price_paise   BIGINT NOT NULL DEFAULT 0 CHECK (options_price_paise >= 0),
  line_total_paise      BIGINT NOT NULL CHECK (line_total_paise >= 0),
  tax_rate_bps_snapshot INT    NOT NULL,
  tax_paise             BIGINT NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  instructions          TEXT,
  is_rejected           BOOLEAN NOT NULL DEFAULT false,   -- item-level rejection (V1)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX order_item_order_idx ON order_item (order_id);

-- Append-only. PRD ORD-SM-02: written in the same transaction as the status change.
CREATE TABLE order_status_history (
  id             BIGSERIAL PRIMARY KEY,
  order_id       UUID         NOT NULL REFERENCES "order"(id) ON DELETE RESTRICT,
  from_status    order_status,
  to_status      order_status NOT NULL,
  actor_type     actor_type   NOT NULL,
  actor_id       UUID,
  reason         TEXT,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX osh_order_idx ON order_status_history (order_id, id);


-- =====================================================================
-- 9. DISPATCH   (PRD §11.2-11.4 — new in v5.0)
-- =====================================================================

CREATE TABLE dispatch_attempt (
  id               BIGSERIAL PRIMARY KEY,
  order_id         UUID NOT NULL REFERENCES "order"(id) ON DELETE RESTRICT,
  target_type      dispatch_target NOT NULL,
  device_id        UUID REFERENCES device(id) ON DELETE SET NULL,
  attempt_no       INT  NOT NULL CHECK (attempt_no >= 1),
  outcome          dispatch_outcome NOT NULL DEFAULT 'SENT',
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at  TIMESTAMPTZ,
  error_code       TEXT,
  error_detail     TEXT,
  correlation_id   TEXT,
  CONSTRAINT dispatch_attempt_uq UNIQUE (order_id, target_type, attempt_no)
);

CREATE INDEX dispatch_order_idx ON dispatch_attempt (order_id, sent_at);
CREATE INDEX dispatch_pending_idx ON dispatch_attempt (sent_at)
  WHERE acknowledged_at IS NULL AND outcome = 'SENT';

CREATE TABLE escalation_state (
  order_id        UUID PRIMARY KEY REFERENCES "order"(id) ON DELETE CASCADE,
  step            INT  NOT NULL DEFAULT 0,     -- 0=scheduled 1=15s 2=45s 3=90s 4=180s
  next_run_at     TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  manager_alerted_at TIMESTAMPTZ,
  customer_offered_cancel_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX escalation_due_idx ON escalation_state (next_run_at)
  WHERE cancelled_at IS NULL;


-- =====================================================================
-- 10. PAYMENTS, REFUNDS, CREDIT
-- =====================================================================

CREATE TABLE payment (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             UUID NOT NULL REFERENCES "order"(id) ON DELETE RESTRICT,
  settlement_mode      settlement_mode NOT NULL,
  provider             TEXT NOT NULL,          -- 'razorpay' | 'cashfree' | ...
  method               TEXT,                   -- 'upi' | 'card' | 'wallet'
  status               payment_status NOT NULL DEFAULT 'INITIATED',
  amount_paise         BIGINT NOT NULL CHECK (amount_paise > 0),
  provider_order_ref   TEXT,
  provider_payment_ref TEXT,
  provider_fee_paise   BIGINT CHECK (provider_fee_paise IS NULL OR provider_fee_paise >= 0),
  split_instruction    JSONB,                  -- Mode A. NULL in Mode B.
  failure_code         TEXT,
  failure_message      TEXT,
  provider_created_at  TIMESTAMPTZ,            -- provider clock, never merged with ours
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded_at         TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PRD §18.3: one payment intent per order, and no duplicate provider reference.
CREATE UNIQUE INDEX payment_order_uq ON payment (order_id);
CREATE UNIQUE INDEX payment_provider_ref_uq ON payment (provider, provider_payment_ref)
  WHERE provider_payment_ref IS NOT NULL;
CREATE INDEX payment_status_idx ON payment (status, created_at DESC);

CREATE TABLE refund (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             UUID NOT NULL REFERENCES "order"(id) ON DELETE RESTRICT,
  payment_id           UUID NOT NULL REFERENCES payment(id) ON DELETE RESTRICT,
  kind                 refund_kind NOT NULL DEFAULT 'FULL',
  amount_paise         BIGINT NOT NULL CHECK (amount_paise > 0),
  status               refund_status NOT NULL DEFAULT 'REQUESTED',
  reason               TEXT,
  provider_refund_ref  TEXT,
  vendor_transfer_reversed BOOLEAN NOT NULL DEFAULT false,
  attempts             INT NOT NULL DEFAULT 0,
  last_error           TEXT,
  next_retry_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at         TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refund_provider_ref_uq ON refund (provider_refund_ref)
  WHERE provider_refund_ref IS NOT NULL;
CREATE INDEX refund_retry_idx ON refund (next_retry_at)
  WHERE status IN ('REQUESTED','PENDING','FAILED');
CREATE INDEX refund_order_idx ON refund (order_id);

-- PRD REF-05: instant credit, mutually exclusive with refund-to-source.
CREATE TABLE platform_credit (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customer(id) ON DELETE RESTRICT,
  food_court_id     UUID NOT NULL REFERENCES food_court(id) ON DELETE RESTRICT,
  origin_order_id   UUID NOT NULL REFERENCES "order"(id) ON DELETE RESTRICT,
  refund_id         UUID REFERENCES refund(id) ON DELETE SET NULL,
  amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),
  status            credit_status NOT NULL DEFAULT 'ISSUED',
  consumed_order_id UUID REFERENCES "order"(id) ON DELETE SET NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at       TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT credit_consumed_consistent CHECK (
    (status = 'CONSUMED') = (consumed_order_id IS NOT NULL)
  )
);

-- One credit per originating order: prevents double-issue on webhook replay.
CREATE UNIQUE INDEX credit_origin_uq ON platform_credit (origin_order_id);
CREATE INDEX credit_customer_idx ON platform_credit (customer_id, status);
CREATE INDEX credit_expiry_idx ON platform_credit (expires_at) WHERE status = 'ISSUED';

-- Webhook idempotency guard (PRD §12.3). Enforced by the database, not by code.
CREATE TABLE processed_event (
  id                 BIGSERIAL PRIMARY KEY,
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  event_type         TEXT,
  order_id           UUID REFERENCES "order"(id) ON DELETE SET NULL,
  payload_digest     TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  CONSTRAINT processed_event_uq UNIQUE (provider, provider_event_id)
);

CREATE INDEX processed_event_order_idx ON processed_event (order_id);


-- =====================================================================
-- 11. LEDGER AND SETTLEMENT
-- =====================================================================

CREATE TABLE ledger_entry (
  id             BIGSERIAL PRIMARY KEY,
  order_id       UUID NOT NULL REFERENCES "order"(id) ON DELETE RESTRICT,
  vendor_id      UUID REFERENCES vendor(id) ON DELETE RESTRICT,
  food_court_id  UUID NOT NULL REFERENCES food_court(id) ON DELETE RESTRICT,
  entry_type     ledger_entry_type NOT NULL,
  party          fee_party,
  direction      ledger_direction NOT NULL,
  amount_paise   BIGINT NOT NULL CHECK (amount_paise >= 0),
  currency       CHAR(3) NOT NULL DEFAULT 'INR',
  authority      ledger_authority NOT NULL,
  reference      TEXT,
  settlement_id  UUID,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_order_idx ON ledger_entry (order_id, id);
CREATE INDEX ledger_vendor_period_idx ON ledger_entry (vendor_id, created_at);
CREATE INDEX ledger_settlement_idx ON ledger_entry (settlement_id) WHERE settlement_id IS NOT NULL;
CREATE INDEX ledger_authority_idx ON ledger_entry (authority, created_at);

CREATE TABLE settlement (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendor(id) ON DELETE RESTRICT,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  gross_paise     BIGINT NOT NULL DEFAULT 0,
  commission_paise BIGINT NOT NULL DEFAULT 0,
  fees_paise      BIGINT NOT NULL DEFAULT 0,
  refunds_paise   BIGINT NOT NULL DEFAULT 0,
  net_paise       BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'DRAFT',
  provider_settlement_ref TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  CONSTRAINT settlement_period_uq UNIQUE (vendor_id, period_start, period_end),
  CONSTRAINT settlement_period_valid CHECK (period_end >= period_start)
);

CREATE TABLE reconciliation_item (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                reconciliation_kind NOT NULL,
  state               reconciliation_state NOT NULL DEFAULT 'OPEN',
  order_id            UUID REFERENCES "order"(id) ON DELETE SET NULL,
  provider            TEXT,
  provider_reference  TEXT,
  expected_paise      BIGINT,
  actual_paise        BIGINT,
  delta_paise         BIGINT GENERATED ALWAYS AS (COALESCE(actual_paise,0) - COALESCE(expected_paise,0)) STORED,
  assignee_user_id    UUID REFERENCES platform_user(id) ON DELETE SET NULL,
  resolution_note     TEXT,
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);

CREATE INDEX recon_open_idx ON reconciliation_item (state, opened_at)
  WHERE state IN ('OPEN','INVESTIGATING');
CREATE UNIQUE INDEX recon_provider_ref_uq
  ON reconciliation_item (kind, provider, provider_reference)
  WHERE provider_reference IS NOT NULL;


-- =====================================================================
-- 12. NOTIFICATIONS, POS, AUDIT
-- =====================================================================

CREATE TABLE notification (
  id                BIGSERIAL PRIMARY KEY,
  order_id          UUID REFERENCES "order"(id) ON DELETE CASCADE,
  event_key         TEXT NOT NULL,           -- e.g. 'order.ready'
  event_version     INT  NOT NULL DEFAULT 1, -- PRD NOTIF-03 dedupe key
  recipient         TEXT,
  tier              notification_tier NOT NULL,
  status            notification_status NOT NULL DEFAULT 'QUEUED',
  attempts          INT NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  provider_response TEXT,
  cost_paise        BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ
);

-- One send per order per event per tier. Replay produces zero extra messages.
CREATE UNIQUE INDEX notification_dedupe_uq
  ON notification (order_id, event_key, event_version, tier);
CREATE INDEX notification_order_idx ON notification (order_id, created_at);

CREATE TABLE pos_integration (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        UUID NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  credentials_ref  TEXT NOT NULL,          -- secret-store reference, never the secret
  external_rest_id TEXT,
  health           integration_health NOT NULL DEFAULT 'UNKNOWN',
  last_success_at  TIMESTAMPTZ,
  last_failure_at  TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0,
  status           entity_status NOT NULL DEFAULT 'DRAFT',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pos_integration_vendor_uq UNIQUE (vendor_id)
);

CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  actor_type     actor_type NOT NULL,
  actor_id       UUID,
  action         TEXT NOT NULL,
  entity         TEXT NOT NULL,
  entity_id      TEXT,
  food_court_id  UUID,
  vendor_id      UUID,
  before_value   JSONB,
  after_value    JSONB,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, created_at DESC);
CREATE INDEX audit_actor_idx  ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_court_idx  ON audit_log (food_court_id, created_at DESC);

CREATE TABLE analytics_event (
  id             BIGSERIAL PRIMARY KEY,
  event_name     TEXT NOT NULL,           -- see TDD §17 event catalogue
  app_session_id UUID,
  customer_id    UUID,
  food_court_id  UUID,
  vendor_id      UUID,
  order_id       UUID,
  properties     JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX analytics_name_time_idx ON analytics_event (event_name, occurred_at);
CREATE INDEX analytics_session_idx ON analytics_event (app_session_id, occurred_at);


-- =====================================================================
-- 13. IMMUTABILITY GUARDS
-- =====================================================================

-- Snapshot columns on "order" must never change after INSERT (PRD DATA-03).
CREATE OR REPLACE FUNCTION assert_order_snapshots_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.settlement_mode_snapshot IS DISTINCT FROM OLD.settlement_mode_snapshot
     OR NEW.fee_rule_snapshot     IS DISTINCT FROM OLD.fee_rule_snapshot
     OR NEW.tax_model_snapshot    IS DISTINCT FROM OLD.tax_model_snapshot
     OR NEW.idempotency_key       IS DISTINCT FROM OLD.idempotency_key
     OR NEW.subtotal_paise        IS DISTINCT FROM OLD.subtotal_paise
     OR NEW.total_payable_paise   IS DISTINCT FROM OLD.total_payable_paise THEN
    RAISE EXCEPTION 'order % snapshot/monetary columns are immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER order_snapshots_immutable
  BEFORE UPDATE ON "order"
  FOR EACH ROW EXECUTE FUNCTION assert_order_snapshots_immutable();

-- Generic updated_at maintenance.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['food_court','court_table','vendor','platform_user','menu',
                           'menu_item','cart','order','payment','refund','pos_integration']
  LOOP
    EXECUTE format(
      -- The trigger name must be built as ONE identifier and passed to a single
      -- %I. Writing %I_touch produces "order"_touch for reserved-word table
      -- names, because %I quotes the identifier and _touch lands outside the
      -- quotes. That is a syntax error, and only for the tables whose names are
      -- reserved words — food_court was fine, "order" was not.
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      t || '_touch', t);
  END LOOP;
END $$;


-- =====================================================================
-- 14. APPEND-ONLY ENFORCEMENT  (PRD LED-01)
--     The application role gets INSERT + SELECT only on these tables.
--     Corrections are compensating entries, never edits.
-- =====================================================================

-- Run once per environment, substituting the real application role name.
--   CREATE ROLE app_rw LOGIN PASSWORD '...';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw';

    -- Then take the dangerous grants back on the append-only tables.
    EXECUTE 'REVOKE UPDATE, DELETE ON ledger_entry          FROM app_rw';
    EXECUTE 'REVOKE UPDATE, DELETE ON order_status_history  FROM app_rw';
    EXECUTE 'REVOKE UPDATE, DELETE ON audit_log             FROM app_rw';
    EXECUTE 'REVOKE DELETE          ON processed_event      FROM app_rw';
    EXECUTE 'REVOKE DELETE          ON dispatch_attempt     FROM app_rw';
  ELSE
    RAISE NOTICE 'role app_rw not found — create it and re-run section 14';
  END IF;
END $$;


-- =====================================================================
-- 15. INVARIANT CHECKS  (run as a nightly job; PRD LED-02)
-- =====================================================================

-- Ledger balance per order: debits must equal credits.
CREATE OR REPLACE VIEW v_ledger_imbalance AS
SELECT order_id,
       SUM(CASE WHEN direction = 'DEBIT'  THEN amount_paise ELSE 0 END) AS debits,
       SUM(CASE WHEN direction = 'CREDIT' THEN amount_paise ELSE 0 END) AS credits,
       SUM(CASE WHEN direction = 'DEBIT'  THEN amount_paise ELSE -amount_paise END) AS delta
FROM ledger_entry
GROUP BY order_id
HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_paise ELSE -amount_paise END) <> 0;

-- Orders paid but never acknowledged and not terminal — the metric that
-- justifies auto-fulfil (PRD §26.1).
CREATE OR REPLACE VIEW v_unacknowledged_orders AS
SELECT o.id, o.public_order_number, o.vendor_id, o.food_court_id,
       o.dispatched_at, now() - o.dispatched_at AS age
FROM "order" o
WHERE o.status = 'DISPATCHED'
ORDER BY o.dispatched_at;

-- Refund-and-credit mutual exclusion breach (PRD REF-05). Must always be empty.
CREATE OR REPLACE VIEW v_credit_refund_conflict AS
SELECT c.id AS credit_id, c.origin_order_id, r.id AS refund_id
FROM platform_credit c
JOIN refund r ON r.order_id = c.origin_order_id
WHERE c.status = 'CONSUMED' AND r.status = 'SUCCEEDED';

-- Any active vendor whose device has gone quiet (PRD KDS-HB-02).
CREATE OR REPLACE VIEW v_stale_vendor_devices AS
SELECT v.id, v.name, v.food_court_id, v.kds_last_heartbeat_at,
       now() - v.kds_last_heartbeat_at AS silence
FROM vendor v
WHERE v.status = 'ACTIVE'
  AND (v.kds_last_heartbeat_at IS NULL OR v.kds_last_heartbeat_at < now() - INTERVAL '60 seconds');

-- migrate:down
-- Deliberately not implemented.
-- Infra & Ops §6.3: never roll back a migration on production to fix an
-- application bug. Roll the application back instead. A down-migration on
-- live financial data is how you lose the ledger.
SELECT 'refusing to drop the ledger' AS note;
