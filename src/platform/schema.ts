/**
 * Kysely table types for the schema in `db/migrations`.
 *
 * Derived once from the DDL, maintained by hand thereafter, and guarded at
 * runtime by a test that fails the moment it disagrees with a real database.
 *
 * WHY THIS IS NOT `kysely-codegen` OUTPUT
 *
 * package.json referenced `kysely-codegen`, which was never actually in
 * devDependencies — `npm run codegen:db` would have failed on any clean
 * checkout. More importantly, codegen only protects you at the moment somebody
 * remembers to run it. Between that moment and the next one, the types and the
 * database drift silently and TypeScript reports nothing, because the types ARE
 * the compiler's only notion of truth.
 *
 * So the guarantee here is not generation, it is conformance:
 * `tests/integration/schema-conformance.test.ts` connects to a real database,
 * reads `information_schema.columns`, and fails if this file and the database
 * disagree about a single column, its type, or its nullability. That runs in CI
 * on every push against the Postgres 16 service, so drift is caught on the
 * commit that causes it rather than the day someone reruns a tool.
 *
 * MONEY IS `number` HERE, NOT `Paise`
 *
 * Deliberate. `Paise` is a branded type and the brand is supposed to mean
 * "this integer has been validated". A row arriving from the driver has been
 * validated by nobody. Branding it at the boundary would make the brand a
 * decoration. Repositories call `toPaise()` on the way in, and that call is
 * where the brand is earned.
 *
 * BIGINT arrives as `number` because `src/platform/db.ts` installs an int8
 * parser that also asserts the value is a safe integer.
 */

import type { ColumnType, Generated } from 'kysely';

/** A value Postgres will accept into JSONB. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * Written by the database, never by us: `DEFAULT now()` on insert and a
 * `_touch` trigger on update. Selecting gives a Date; inserting and updating
 * are forbidden, which is what makes "the application must not set updated_at"
 * a compile error rather than a code-review comment.
 */
export type DbManaged = ColumnType<Date, never, never>;

export type SettlementMode = 'PLATFORM_COLLECT' | 'VENDOR_DIRECT';

/**
 * NARROWER THAN THE DATABASE ENUM, DELIBERATELY.
 *
 * PostgreSQL cannot drop an enum label, so `order_status` still contains
 * 'COMPLETED' and `payment_status` still contains 'INITIATED' and 'SUCCESS'.
 * Migration 20260817000007 fences them off with CHECK constraints, and these
 * unions say the same thing to the compiler: writing a retired value is a type
 * error here and a constraint violation there. Two independent refusals of the
 * same mistake, which is the point.
 *
 * The conformance test checks that an enum column is not widened to `string`.
 * It does not require the union to enumerate every label the type happens to
 * carry, because a label nothing may write is not part of the vocabulary.
 */
export type OrderStatus =
  | 'CREATED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_CONFIRMED'
  | 'DISPATCHED'
  | 'ACKNOWLEDGED'
  | 'PREPARING'
  | 'READY'
  | 'COLLECTED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_EXPIRED'
  | 'DISPATCH_FAILED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REFUND_FAILED'
  | 'RECONCILIATION_REQUIRED';

/** PRD §8. The payment is its own object with its own lifecycle. */
export type PaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUND_FAILED'
  | 'RECONCILIATION_REQUIRED';

/** PRD §6. Does this item exist on the menu at all. */
export type ProductStatus = 'ACTIVE' | 'INACTIVE';

/** PRD §6. Can it be ordered right now. Not the same question as the above. */
export type ItemAvailability = 'AVAILABLE' | 'SOLD_OUT' | 'TEMPORARILY_UNAVAILABLE';

/** PRD §6. Is a count being kept. */
export type InventoryMode = 'TRACKED' | 'UNTRACKED';

/** How a one-time code reached the customer. PRD §11.2. */
export type OtpChannel = 'SMS' | 'WHATSAPP' | 'CONSOLE';

export type RefundStatus = 'REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ABANDONED';

export type RefundKind = 'FULL' | 'PARTIAL';

export type DispatchTarget = 'KDS' | 'PRINTER' | 'POS';

export type DispatchOutcome = 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'TIMED_OUT';

export type LedgerAuthority = 'AUTHORITATIVE' | 'ADVISORY';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export type LedgerEntryType =
  | 'GROSS_ORDER_VALUE'
  | 'FOOD_TAX'
  | 'CUSTOMER_PLATFORM_FEE'
  | 'CUSTOMER_FEE_TAX'
  | 'VENDOR_COMMISSION'
  | 'VENDOR_COMMISSION_TAX'
  | 'OPERATOR_SHARE'
  | 'OPERATOR_SHARE_TAX'
  | 'PLATFORM_TAX_RESERVE'
  | 'PROVIDER_FEE'
  | 'VENDOR_NET_PAYABLE'
  | 'REFUND'
  | 'REFUND_REVERSAL_VENDOR'
  | 'PLATFORM_CREDIT_ISSUED'
  | 'PLATFORM_CREDIT_CONSUMED'
  | 'PLATFORM_CREDIT_EXPIRED'
  | 'ADJUSTMENT';

export type FeeParty = 'CUSTOMER' | 'VENDOR' | 'OPERATOR';

export type FeeType = 'PERCENTAGE' | 'FLAT_PER_ORDER' | 'SUBSCRIPTION_MONTHLY';

export type FeeScope = 'PLATFORM_DEFAULT' | 'FOOD_COURT' | 'VENDOR';

export type ActorType =
  | 'CUSTOMER'
  | 'VENDOR_USER'
  | 'MANAGER'
  | 'PLATFORM_OPS'
  | 'PLATFORM_FINANCE'
  | 'SUPER_ADMIN'
  | 'SYSTEM'
  | 'PROVIDER_WEBHOOK'
  | 'POS_WEBHOOK';

/**
 * Authorisation roles. Distinct from ActorType on purpose — see migration
 * 20260812000004. This list must stay identical to ROLES in
 * src/identity/permissions.ts; the RBAC matrix is written against it.
 */
export type PlatformRole =
  | 'CUSTOMER'
  | 'DEVICE'
  | 'VENDOR_OPERATOR'
  | 'VENDOR_OWNER'
  | 'MANAGER'
  | 'COURT_OPERATOR'
  | 'PLATFORM_OPS'
  | 'PLATFORM_FINANCE'
  | 'SUPER_ADMIN';

export type CreditStatus = 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'VOIDED';

export type ReconciliationState = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'WRITTEN_OFF';

export type ReconciliationKind =
  | 'PROVIDER_TXN_NO_ORDER'
  | 'ORDER_NO_PROVIDER_TXN'
  | 'AMOUNT_MISMATCH'
  | 'REFUND_UNCONFIRMED'
  | 'POS_STATE_DIVERGENCE'
  | 'SPLIT_MISMATCH';

export type NotificationTier =
  | 'WEBSOCKET'
  | 'WAKE_LOCK'
  | 'WEB_PUSH'
  | 'WHATSAPP'
  | 'SMS'
  | 'DISPLAY_BOARD';

export type NotificationStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'SKIPPED' | 'NOT_APPLICABLE';

export type EntityStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';

export type DeviceKind = 'KDS_TABLET' | 'THERMAL_PRINTER' | 'DISPLAY_BOARD';

export type RejectionReason =
  | 'ITEM_OUT_OF_STOCK'
  | 'KITCHEN_OVERLOADED'
  | 'EQUIPMENT_FAILURE'
  | 'VENDOR_CLOSING'
  | 'INGREDIENT_UNAVAILABLE'
  | 'PRICE_OR_MENU_ERROR'
  | 'CUSTOMER_REQUEST'
  | 'DUPLICATE_ORDER'
  | 'OTHER';

export type MenuSourceType = 'PLATFORM' | 'POS_PETPOOJA' | 'POS_OTHER';

export type IntegrationHealth = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface FoodCourtTable {
  id: Generated<string>;
  name: string;
  /** The scannable identity of the court. One QR per venue, not per table. */
  qr_token: string | null;
  city: string;
  address: string | null;
  timezone: Generated<string>;
  operating_hours: Generated<Json>;
  config: Generated<Json>;
  status: Generated<EntityStatus>;
  created_at: Generated<Date>;
  updated_at: DbManaged;
}

export interface CourtTableTable {
  id: Generated<string>;
  food_court_id: string;
  label: string;
  qr_token: string;
  status: Generated<EntityStatus>;
  deactivated_at: Date | null;
  created_at: Generated<Date>;
  updated_at: DbManaged;
}

export interface VendorTable {
  id: Generated<string>;
  food_court_id: string;
  name: string;
  legal_name: string | null;
  cuisine: Generated<string[]>;
  status: Generated<EntityStatus>;
  settlement_mode: SettlementMode | null;
  pan: string | null;
  gstin: string | null;
  fssai_licence: string | null;
  bank_account_ref: string | null;
  kyc_completed_at: Date | null;
  provider_linked_account_id: string | null;
  operating_hours: Generated<Json>;
  temp_closed_until: Date | null;
  estimated_prep_minutes: Generated<number>;
  kds_last_heartbeat_at: Date | null;
  dispatch_blocked_at: Date | null;
  /**
   * Imagery. Both optional, permanently — a stall goes live without a
   * photographer and the app draws a generated tile instead. See migration 12.
   */
  cover_image_url: string | null;
  logo_url: string | null;
  /**
   * The carousel offer. Marketing only — it applies no discount at checkout.
   *
   * `offer_uploads_enabled` is the PLATFORM's grant and `offer_image_url` is
   * the STALL's artwork. Neither party can do the other's half. See migration 14.
   */
  offer_image_url: string | null;
  offer_headline: string | null;
  offer_uploads_enabled: Generated<boolean>;
  /**
   * How many AI description generations this stall may spend, ever. See
   * migration 17. Two by default; the platform raises it on request, which is
   * what "contact the administration for more credits" resolves to.
   */
  ai_description_credits: Generated<number>;
  /**
   * Cashfree Easy Split payee id. NULL until the stall is onboarded to payouts.
   *
   * `settlement_mode` — which mode this stall settles in — is NOT here: it has
   * been on `vendor` since migration 1, a few lines above. See migration 18.
  /**
   * The stall asking, and the platform answering. See migration 15.
   *
   * Two timestamps rather than one flag: "asked, nobody has looked" and
   * "asked, the office said no" must read differently to the stall, or a
   * decline is indistinguishable from a lost request and it asks again weekly.
   */
  offer_slot_requested_at: Date | null;
  offer_slot_decided_at: Date | null;
  created_at: Generated<Date>;
  updated_at: DbManaged;
}

export interface PlatformUserTable {
  id: Generated<string>;
  /** CITEXT — compares case-insensitively in the database, so no `.toLowerCase()` at call sites. */
  email: string | null;
  phone: string | null;
  display_name: string;
  password_hash: string | null;
  status: Generated<EntityStatus>;
  created_at: Generated<Date>;
  updated_at: DbManaged;
}

export interface UserRoleAssignmentTable {
  id: Generated<string>;
  user_id: string;
  role: PlatformRole;
  food_court_id: string | null;
  vendor_id: string | null;
  status: Generated<EntityStatus>;
  created_at: Generated<Date>;
}

export interface DeviceTable {
  id: Generated<string>;
  vendor_id: string | null;
  food_court_id: string;
  kind: DeviceKind;
  label: string;
  secret_hash: string;
  last_heartbeat_at: Date | null;
  app_version: string | null;
  status: Generated<EntityStatus>;
  created_at: Generated<Date>;
}

export interface CustomerTable {
  id: Generated<string>;
  /** E.164, enforced by `customer_phone_e164`. Unique where not null. */
  phone: string | null;
  /**
   * Optional, and never required to order.
   *
   * What to call the customer at the counter. `display_name` rather than `name`
   * to match `platform_user.display_name` — two columns meaning "what to call
   * this person" should not be spelled two ways.
   */
  display_name: string | null;
  phone_verified_at: Date | null;
  whatsapp_opt_in_at: Date | null;
  whatsapp_consent_version: string | null;
  /** Bumping this revokes every token this customer holds. AUTH-05. */
  token_version: Generated<number>;
  last_seen_at: Date | null;
  created_at: Generated<Date>;
}

export interface CustomerOtpTable {
  id: Generated<string>;
  phone: string;
  /** HMAC-SHA-256 under a server pepper, never the code. See src/identity/otp.ts. */
  code_hash: string;
  app_session_id: string | null;
  channel: OtpChannel;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  expires_at: Date;
  dispatched_at: Date | null;
  dispatch_error: string | null;
  consumed_at: Date | null;
  superseded_at: Date | null;
  correlation_id: string | null;
  created_at: Generated<Date>;
}

export interface RateLimitCounterTable {
  bucket: string;
  window_start: Date;
  hits: Generated<number>;
  updated_at: Generated<Date>;
}

export interface AppSessionTable {
  id: Generated<string>;
  customer_id: string | null;
  food_court_id: string;
  court_table_id: string | null;
  active_vendor_id: string | null;
  device_fingerprint: string | null;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Date;
}

export interface MenuTable {
  id: Generated<string>;
  vendor_id: string;
  source_type: Generated<MenuSourceType>;
  source_version: string | null;
  synced_at: Date | null;
  is_stale: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: DbManaged;
}

export interface MenuCategoryTable {
  id: Generated<string>;
  menu_id: string;
  name: string;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
}

export interface MenuItemTable {
  id: Generated<string>;
  menu_id: string;
  menu_category_id: string;
  external_item_id: string | null;
  name: string;
  description: string | null;
  base_price_paise: number;
  tax_rate_bps: Generated<number>;
  image_url: string | null;
  dietary_flags: Generated<string[]>;
  /** PRD §6 — three separate concepts, deliberately not one boolean. */
  status: Generated<ProductStatus>;
  availability: Generated<ItemAvailability>;
  inventory_mode: Generated<InventoryMode>;
  /**
   * When availability reverts to AVAILABLE by itself. Null while available.
   *
   * Formerly `unavailable_until`, which read as a double negative at every
   * call site and looked like it applied only to temporary closure.
   */
  available_from: Date | null;
  sort_order: Generated<number>;
  /**
   * The STALL's own recommendation — migration 21.
   *
   * Deliberately not the same thing as the computed `bestseller` the discovery
   * menu sends: that one is SUM(quantity) over seven days and is not editable
   * by anybody. This is a cook's opinion, capped at three per vendor by the
   * endpoint, and the customer app labels it "Must try" rather than borrowing
   * a word that implies a measurement.
   */
  must_try: Generated<boolean>;
  variant_groups: Generated<Json>;
  addon_groups: Generated<Json>;
  created_at: Generated<Date>;
  updated_at: DbManaged;
  /** Warn the kitchen at or below this many. NULL uses the platform default. */
  low_stock_threshold: number | null;
}

/** One row per item per court-local service day. PRD §6. */
export interface MenuItemStockTable {
  menu_item_id: string;
  service_date: string;
  daily_stock: number;
  set_by: string | null;
  created_at: Generated<Date>;
  updated_at: DbManaged;
}

export interface MenuItemStockHistoryTable {
  id: Generated<number>;
  menu_item_id: string;
  service_date: string;
  previous_stock: number | null;
  new_stock: number;
  actor_type: ActorType;
  actor_id: string | null;
  note: string | null;
  correlation_id: string | null;
  created_at: Generated<Date>;
}

export interface CartTable {
  id: Generated<string>;
  app_session_id: string;
  vendor_id: string;
  pricing_snapshot: Json | null;
  expires_at: Date;
  created_at: Generated<Date>;
  updated_at: DbManaged;
}

export interface CartItemTable {
  id: Generated<string>;
  cart_id: string;
  menu_item_id: string;
  vendor_id: string;
  quantity: number;
  selected_options: Generated<Json>;
  instructions: string | null;
  created_at: Generated<Date>;
}

export interface FeeRuleTable {
  id: Generated<string>;
  scope: FeeScope;
  food_court_id: string | null;
  vendor_id: string | null;
  party: FeeParty;
  fee_type: FeeType;
  rate_bps: number | null;
  amount_paise: number | null;
  min_floor_paise: Generated<number>;
  max_cap_paise: number | null;
  tax_rate_bps: Generated<number>;
  allowed_modes: Generated<SettlementMode[]>;
  version: Generated<number>;
  effective_from: Generated<Date>;
  effective_to: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface OrderTable {
  id: Generated<string>;
  public_order_number: string;
  /**
   * The trading day this order belongs to. See migration 19.
   *
   * Set by the application rather than derived from `created_at`, because the
   * unique index keys on it and no timezone-dependent expression may appear in
   * an index. `public_order_number` is unique within a court PER DAY.
   */
  business_date: string;
  app_session_id: string | null;
  customer_id: string | null;
  food_court_id: string;
  vendor_id: string;
  court_table_id: string | null;
  status: Generated<OrderStatus>;
  settlement_mode_snapshot: SettlementMode;
  fee_rule_snapshot: Json;
  tax_model_snapshot: Json;
  subtotal_paise: number;
  food_tax_paise: Generated<number>;
  customer_fee_paise: Generated<number>;
  customer_fee_tax_paise: Generated<number>;
  discount_paise: Generated<number>;
  total_payable_paise: number;
  vendor_commission_paise: Generated<number>;
  operator_share_paise: Generated<number>;
  platform_tax_reserve_paise: Generated<number>;
  vendor_net_paise: Generated<number>;
  idempotency_key: string;
  correlation_id: string;
  rejection_reason: RejectionReason | null;
  rejection_note: string | null;
  customer_phone_snapshot: string | null;
  payer_reference: string | null;
  created_at: Generated<Date>;
  payment_confirmed_at: Date | null;
  dispatched_at: Date | null;
  acknowledged_at: Date | null;
  preparing_at: Date | null;
  ready_at: Date | null;
  /** PRD §7.1 — handed over, not merely cooked. Renamed from completed_at. */
  collected_at: Date | null;
  terminal_at: Date | null;
  updated_at: DbManaged;
}

export interface OrderItemTable {
  id: Generated<string>;
  order_id: string;
  menu_item_id: string | null;
  external_item_id: string | null;
  name_snapshot: string;
  unit_price_paise_snapshot: number;
  quantity: number;
  options_snapshot: Generated<Json>;
  options_price_paise: Generated<number>;
  line_total_paise: number;
  tax_rate_bps_snapshot: number;
  tax_paise: Generated<number>;
  instructions: string | null;
  is_rejected: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface OrderStatusHistoryTable {
  id: Generated<number>;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  actor_type: ActorType;
  actor_id: string | null;
  reason: string | null;
  correlation_id: string | null;
  created_at: Generated<Date>;
}

export interface DispatchAttemptTable {
  id: Generated<number>;
  order_id: string;
  target_type: DispatchTarget;
  device_id: string | null;
  attempt_no: number;
  outcome: Generated<DispatchOutcome>;
  sent_at: Generated<Date>;
  acknowledged_at: Date | null;
  error_code: string | null;
  error_detail: string | null;
  correlation_id: string | null;
}

export interface EscalationStateTable {
  order_id: string;
  step: Generated<number>;
  next_run_at: Date | null;
  cancelled_at: Date | null;
  manager_alerted_at: Date | null;
  customer_offered_cancel_at: Date | null;
  updated_at: DbManaged;
}

export interface PaymentTable {
  id: Generated<string>;
  order_id: string;
  settlement_mode: SettlementMode;
  provider: string;
  method: string | null;
  status: Generated<PaymentStatus>;
  amount_paise: number;
  provider_order_ref: string | null;
  provider_payment_ref: string | null;
  provider_fee_paise: number | null;
  split_instruction: Json | null;
  /**
   * What the provider gave the client to open a checkout with. See migration 20.
   *
   * Stored because `createIntent` returns an existing live intent, and the
   * payload cannot be rebuilt: Cashfree issues `payment_session_id` once, at
   * order creation. Without this, the second request for the same intent
   * returned a reconstruction with no session in it.
   */
  checkout_payload: Json | null;
  failure_code: string | null;
  failure_message: string | null;
  provider_created_at: Date | null;
  created_at: Generated<Date>;
  /** Funds blocked, not taken. PRD §8.1. */
  authorized_at: Date | null;
  /** Funds taken. Renamed from succeeded_at, which was as vague as SUCCESS. */
  captured_at: Date | null;
  /** When the intent or the block lapses. PAY-REC-06. */
  expires_at: Date | null;
  refunded_paise: Generated<number>;
  updated_at: DbManaged;
}

export interface RefundTable {
  id: Generated<string>;
  order_id: string;
  payment_id: string;
  kind: Generated<RefundKind>;
  amount_paise: number;
  status: Generated<RefundStatus>;
  reason: string | null;
  provider_refund_ref: string | null;
  vendor_transfer_reversed: Generated<boolean>;
  attempts: Generated<number>;
  last_error: string | null;
  next_retry_at: Date | null;
  created_at: Generated<Date>;
  confirmed_at: Date | null;
  updated_at: DbManaged;
}

export interface PlatformCreditTable {
  id: Generated<string>;
  customer_id: string;
  food_court_id: string;
  origin_order_id: string;
  refund_id: string | null;
  amount_paise: number;
  status: Generated<CreditStatus>;
  consumed_order_id: string | null;
  issued_at: Generated<Date>;
  consumed_at: Date | null;
  expires_at: Date;
}

export interface ProcessedEventTable {
  id: Generated<number>;
  provider: string;
  provider_event_id: string;
  event_type: string | null;
  order_id: string | null;
  payload_digest: string | null;
  received_at: Generated<Date>;
  processed_at: Date | null;
}

export interface LedgerEntryTable {
  id: Generated<number>;
  order_id: string;
  vendor_id: string | null;
  food_court_id: string;
  entry_type: LedgerEntryType;
  party: FeeParty | null;
  direction: LedgerDirection;
  amount_paise: number;
  currency: Generated<string>;
  authority: LedgerAuthority;
  reference: string | null;
  settlement_id: string | null;
  correlation_id: string | null;
  created_at: Generated<Date>;
}

export interface SettlementTable {
  id: Generated<string>;
  vendor_id: string;
  period_start: Date;
  period_end: Date;
  gross_paise: Generated<number>;
  commission_paise: Generated<number>;
  fees_paise: Generated<number>;
  refunds_paise: Generated<number>;
  net_paise: Generated<number>;
  status: Generated<string>;
  provider_settlement_ref: string | null;
  created_at: Generated<Date>;
  settled_at: Date | null;
}

export interface ReconciliationItemTable {
  id: Generated<string>;
  kind: ReconciliationKind;
  state: Generated<ReconciliationState>;
  order_id: string | null;
  provider: string | null;
  provider_reference: string | null;
  expected_paise: number | null;
  actual_paise: number | null;
  delta_paise: number | null;
  assignee_user_id: string | null;
  resolution_note: string | null;
  opened_at: Generated<Date>;
  resolved_at: Date | null;
}

export interface NotificationTable {
  id: Generated<number>;
  order_id: string | null;
  event_key: string;
  event_version: Generated<number>;
  recipient: string | null;
  tier: NotificationTier;
  status: Generated<NotificationStatus>;
  attempts: Generated<number>;
  provider_message_id: string | null;
  provider_response: string | null;
  cost_paise: Generated<number>;
  created_at: Generated<Date>;
  sent_at: Date | null;
  delivered_at: Date | null;
}

export interface PosIntegrationTable {
  id: Generated<string>;
  vendor_id: string;
  provider: string;
  credentials_ref: string;
  external_rest_id: string | null;
  health: Generated<IntegrationHealth>;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  consecutive_failures: Generated<number>;
  status: Generated<EntityStatus>;
  created_at: Generated<Date>;
  updated_at: DbManaged;
}

export interface AuditLogTable {
  id: Generated<number>;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  food_court_id: string | null;
  vendor_id: string | null;
  before_value: Json | null;
  after_value: Json | null;
  metadata: Generated<Json>;
  correlation_id: string | null;
  created_at: Generated<Date>;
}

export interface AnalyticsEventTable {
  id: Generated<number>;
  event_name: string;
  app_session_id: string | null;
  customer_id: string | null;
  food_court_id: string | null;
  vendor_id: string | null;
  order_id: string | null;
  properties: Generated<Json>;
  occurred_at: Generated<Date>;
}

/** The shape `Kysely<Database>` is parameterised by. */
/**
 * A diner asked to be told when a sold-out dish is orderable again.
 *
 * Keyed on the SESSION rather than the customer: most people who hit a sold-out
 * item have never verified a phone number, and keying on `customer_id` would
 * offer the feature only to people who had already bought something.
 */
export interface StockWatchTable {
  id: Generated<string>;
  menu_item_id: string;
  app_session_id: string;
  customer_id: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  /** Set once by the sweep. The exactly-once guard — never cleared. */
  restocked_at: Date | null;
  /** The customer was shown it. A different fact from `restocked_at`. */
  seen_at: Date | null;
}

/**
 * One AI description attempt. See migration 17.
 *
 * A ledger rather than a counter on `vendor`: usage is `COUNT(*) WHERE outcome
 * = 'OK'`, which is derived from the events that caused it and so cannot drift
 * from them. It is also the only shape that can answer "when, on what dish, and
 * did it actually work" — the questions that arrive the first time a stall says
 * it never spent its credits.
 */
export interface AiGenerationTable {
  id: Generated<string>;
  vendor_id: string;
  /** Null when generated for a dish not saved yet, or one deleted since. */
  menu_item_id: string | null;
  dish_name: string;
  provider: string;
  model: string;
  /** Only `'OK'` is charged. Failures are recorded and free. */
  outcome: string;
  generated_text: string | null;
  duration_ms: number | null;
  staff_user_id: string | null;
  created_at: Generated<Date>;
}

export interface Database {
  food_court: FoodCourtTable;
  court_table: CourtTableTable;
  vendor: VendorTable;
  platform_user: PlatformUserTable;
  user_role_assignment: UserRoleAssignmentTable;
  device: DeviceTable;
  customer: CustomerTable;
  customer_otp: CustomerOtpTable;
  rate_limit_counter: RateLimitCounterTable;
  app_session: AppSessionTable;
  menu: MenuTable;
  menu_category: MenuCategoryTable;
  menu_item: MenuItemTable;
  menu_item_stock: MenuItemStockTable;
  menu_item_stock_history: MenuItemStockHistoryTable;
  cart: CartTable;
  cart_item: CartItemTable;
  fee_rule: FeeRuleTable;
  'order': OrderTable;
  order_item: OrderItemTable;
  stock_watch: StockWatchTable;
  order_status_history: OrderStatusHistoryTable;
  dispatch_attempt: DispatchAttemptTable;
  escalation_state: EscalationStateTable;
  payment: PaymentTable;
  refund: RefundTable;
  platform_credit: PlatformCreditTable;
  processed_event: ProcessedEventTable;
  ledger_entry: LedgerEntryTable;
  settlement: SettlementTable;
  reconciliation_item: ReconciliationItemTable;
  notification: NotificationTable;
  pos_integration: PosIntegrationTable;
  ai_generation: AiGenerationTable;
  audit_log: AuditLogTable;
  analytics_event: AnalyticsEventTable;
  schema_migrations: SchemaMigrationsTable;

  // Views. Selectable, never insertable — see the note below.
  v_menu_item_stock_remaining: MenuItemStockRemainingView;
}

export interface SchemaMigrationsTable {
  version: string;
  filename: string;
  applied_at: Generated<Date>;
}

/**
 * VIEWS.
 *
 * Read-only, and typed so Kysely can select from them. Every column is
 * non-optional on select and none may be inserted — a view that looks
 * writeable in the type system is an invitation to try.
 *
 * The conformance test filters `information_schema.tables` to BASE TABLE, so
 * these are deliberately outside the `Database` tables it checks and are
 * declared here instead.
 */
export interface MenuItemStockRemainingView {
  menu_item_id: ColumnType<string, never, never>;
  service_date: ColumnType<string, never, never>;
  daily_stock: ColumnType<number, never, never>;
  consumed: ColumnType<number, never, never>;
  /** May be negative. See v_stock_oversold and migration 008. */
  remaining: ColumnType<number, never, never>;
}
