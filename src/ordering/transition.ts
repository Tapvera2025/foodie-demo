/**
 * The one place an order's status changes.
 *
 * PRD ORD-SM-01/04: status is never assigned. It moves only through a command
 * that takes a row lock, validates against the allow-list, and appends to
 * `order_status_history` in the same transaction — so an order is
 * reconstructable from its history alone.
 *
 * WHY THIS IS A MODULE AND NOT A METHOD ON THE KDS CONTROLLER
 *
 * It was a private method on the KDS controller. The moment the payment engine
 * needed to confirm an order, the choice was to import a controller or to copy
 * forty lines — and the copy would have been the one without the row lock,
 * because the lock is the part that looks optional until two writers arrive at
 * once. The escalation worker will be the third caller and the expiry sweeper
 * the fourth.
 */

import type { Transaction } from 'kysely';

import { AppError } from '../platform/errors.js';
import { publishOrderChanged } from '../realtime/publish.js';
import type { ActorType, Database, OrderStatus, RejectionReason } from '../platform/schema.js';
import { assertTransitionAllowed } from './state-machine.js';

/** Which timestamp column each arrival stamps. */
const STAMP: Partial<Record<OrderStatus, keyof Database['order'] & string>> = {
  PAYMENT_CONFIRMED: 'payment_confirmed_at',
  DISPATCHED: 'dispatched_at',
  ACKNOWLEDGED: 'acknowledged_at',
  PREPARING: 'preparing_at',
  READY: 'ready_at',
  COLLECTED: 'collected_at',
};

/**
 * States after which nothing more will happen to this order.
 *
 * Listed rather than derived from `isTerminal`, because REJECTED and CANCELLED
 * are not terminal in the state machine — a refund follows — but they are the
 * moment the order stopped moving forward, and that is what `terminal_at`
 * records for the reports.
 */
const STOPS_HERE: readonly OrderStatus[] = [
  'COLLECTED',
  'REJECTED',
  'CANCELLED',
  'PAYMENT_FAILED',
  'PAYMENT_EXPIRED',
  'REFUNDED',
];

export interface TransitionInput {
  readonly orderId: string;
  readonly to: OrderStatus;
  readonly actorType: ActorType;
  readonly actorId?: string | null;
  readonly correlationId?: string | null;
  /** Mandatory for REJECTED — enforced by the database as well. */
  readonly rejectionReason?: RejectionReason | null;
  readonly rejectionNote?: string | null;
  /**
   * Restricts the transition to one vendor's orders. The KDS passes the vendor
   * from the token; the payment engine passes nothing because a webhook is not
   * scoped to a stall.
   */
  readonly requireVendorId?: string;
}

export interface TransitionResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly from: OrderStatus;
  readonly status: OrderStatus;
  /** False when the order was already there. Not an error — see below. */
  readonly changed: boolean;
}

/**
 * Move one order, inside a transaction the caller owns.
 *
 * The caller owns the transaction on purpose: confirming a payment writes the
 * payment row and the order in one unit, and a helper that opened its own
 * transaction would make that impossible to express.
 */
export async function transitionOrder(
  trx: Transaction<Database>,
  input: TransitionInput,
): Promise<TransitionResult> {
  // FOR UPDATE matters more here than anywhere else in the application. A
  // kitchen tablet double-tap, a webhook retry and the escalation worker can
  // reach the same order in the same millisecond, and two of those three are
  // machines that will keep trying.
  //
  // `customer_id` and `food_court_id` are selected for the realtime broadcast
  // at the end of this function, not for the transition itself. Taken here
  // because the row is already locked and read — a second query for two
  // columns on a row we are holding would be pure waste.
  const order = await trx
    .selectFrom('order')
    .select([
      'id',
      'status',
      'public_order_number',
      'vendor_id',
      'customer_id',
      'food_court_id',
    ])
    .where('id', '=', input.orderId)
    .forUpdate()
    .executeTakeFirst();

  // 404 for another stall's order, never 403 — PRD TENANT-01. A different
  // status code would confirm the order exists.
  if (!order || (input.requireVendorId !== undefined && order.vendor_id !== input.requireVendorId)) {
    throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');
  }

  // Idempotent by design. A tablet on bad wi-fi retries and a provider redelivers
  // a webhook; the second "ready" must not be an error the cook has to think
  // about, and the second "confirm" must not write a second history row.
  if (order.status === input.to) {
    return {
      orderId: order.id,
      orderNumber: order.public_order_number,
      from: order.status,
      status: input.to,
      changed: false,
    };
  }

  assertTransitionAllowed(order.status, input.to);

  const now = new Date();
  const stamp = STAMP[input.to];

  await trx
    .updateTable('order')
    .set({
      status: input.to,
      ...(stamp ? { [stamp]: now } : {}),
      ...(STOPS_HERE.includes(input.to) ? { terminal_at: now } : {}),
      ...(input.to === 'REJECTED'
        ? {
            rejection_reason: input.rejectionReason ?? 'OTHER',
            rejection_note: input.rejectionNote ?? null,
          }
        : {}),
    })
    .where('id', '=', input.orderId)
    .execute();

  await trx
    .insertInto('order_status_history')
    .values({
      order_id: input.orderId,
      from_status: order.status,
      to_status: input.to,
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      reason: input.rejectionReason ?? null,
      correlation_id: input.correlationId ?? null,
    })
    .execute();

  /*
   * ==========================================================================
   * THE ONE PLACE A STATUS CHANGE IS ANNOUNCED
   * ==========================================================================
   *
   * Here, and not at the call sites. Every route into a status change already
   * funnels through this function — the kitchen accepting or rejecting, the
   * payment webhook confirming, the dispatcher, the escalation ladder, a
   * forced cancel from the console — so putting the broadcast here means a
   * transition added next year is announced without anybody remembering to
   * announce it. A publish at each caller is a list that goes stale the first
   * time somebody adds the seventh caller.
   *
   * AFTER the `changed === false` early return above, deliberately. An
   * idempotent repeat — a tablet double-tap, a redelivered webhook — writes no
   * history row and must not wake every client either. Only a real move is
   * news.
   *
   * INSIDE the transaction, on `trx`. If this transaction rolls back, so does
   * the notification: no client is ever told about a transition the database
   * refused. That is the property `bus.ts` picked LISTEN/NOTIFY for, and this
   * line is where it is actually collected.
   *
   * NOT AWAITED FOR CORRECTNESS — `publish` swallows its own failures — but it
   * is awaited for ORDERING: the notify statement has to reach the connection
   * before the transaction commits, or it is not part of it.
   */
  await publishOrderChanged(trx, {
    orderId: order.id,
    vendorId: order.vendor_id,
    customerId: order.customer_id,
    foodCourtId: order.food_court_id,
  });

  return {
    orderId: order.id,
    orderNumber: order.public_order_number,
    from: order.status,
    status: input.to,
    changed: true,
  };
}
