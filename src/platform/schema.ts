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

export type OrderStatus =
  | 'CREATED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_CONFIRMED'
  | 'DISPATCHED'
  | 'ACKNOWLEDGED'
  | 'PREPARING'
  | 'READY'
  | 'COMPLETED'
  | 'PAYMENT_FAILED'
  | 'DISPATCH_FAILED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REFUND_FAILED'
  | 'RECONCILIATION_REQUIRED';

export type PaymentStatus =
  | 'INITIATED'
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REFUND_FAILED'
  | 'RECONCILIATION_REQUIRED';

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
  role: ActorType;
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
  phone: string | null;
  phone_verified_at: Date | null;
  whatsapp_opt_in_at: Date | null;
  whatsapp_consent_version: string | null;
  created_at: Generated<Date>;
}

export interface AppSessionTable {
  id: Generated<string>;
  customer_id: string | null;
  food_court_id: string;
  court_table_id: string;
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
  is_available: Generated<boolean>;
  unavailable_until: Date | null;
  sort_order: Generated<number>;
  variant_groups: Generated<Json>;
  addon_groups: Generated<Json>;
  created_at: Generated<Date>;
  updated_at: DbManaged;
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
  app_session_id: string | null;
  customer_id: string | null;
  food_court_id: string;
  vendor_id: string;
  court_table_id: string;
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
  completed_at: Date | null;
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
  failure_code: string | null;
  failure_message: string | null;
  provider_created_at: Date | null;
  created_at: Generated<Date>;
  succeeded_at: Date | null;
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
export interface Database {
  food_court: FoodCourtTable;
  court_table: CourtTableTable;
  vendor: VendorTable;
  platform_user: PlatformUserTable;
  user_role_assignment: UserRoleAssignmentTable;
  device: DeviceTable;
  customer: CustomerTable;
  app_session: AppSessionTable;
  menu: MenuTable;
  menu_category: MenuCategoryTable;
  menu_item: MenuItemTable;
  cart: CartTable;
  cart_item: CartItemTable;
  fee_rule: FeeRuleTable;
  'order': OrderTable;
  order_item: OrderItemTable;
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
  audit_log: AuditLogTable;
  analytics_event: AnalyticsEventTable;
  schema_migrations: SchemaMigrationsTable;
}

export interface SchemaMigrationsTable {
  version: string;
  filename: string;
  applied_at: Generated<Date>;
}
