/**
 * ============================================================================
 * WHAT DOMAIN CODE CALLS. TWO FUNCTIONS, AND NEITHER TAKES A ROOM NAME.
 * ============================================================================
 *
 * Call sites say WHAT HAPPENED — "order 123 at stall 456 changed" — and this
 * file decides who hears about it. That split is the point:
 *
 *   - a call site cannot address the wrong audience, because it cannot address
 *     an audience at all
 *   - when the rule changes (a court-wide console, an area manager, a second
 *     kind of staff), it changes HERE, once, and every existing call site is
 *     already correct
 *
 * The alternative — `publish(customerRoom(x), …)` at forty call sites — puts
 * a tenancy decision in forty places, thirty-nine of which will be copied from
 * the fortieth without being re-read.
 *
 * ----------------------------------------------------------------------------
 * PASS THE TRANSACTION'S CONNECTION WHENEVER THERE IS ONE
 * ----------------------------------------------------------------------------
 *
 * `db` is any Kysely executor, which includes a transaction. Passing the
 * TRANSACTION is strongly preferred and is the reason `bus.ts` chose this
 * transport — the notification then commits or aborts with the change it
 * describes, and a rolled-back acceptance cannot tell a customer their food is
 * being made.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../platform/schema.js';
import { publish, type BusMessage } from './bus.js';
import {
  CATALOG_CHANGED,
  ORDER_CHANGED,
  courtRoom,
  customerRoom,
  vendorRoom,
} from './rooms.js';

/**
 * `Transaction<Database>` extends `Kysely<Database>`, so this covers both and
 * every call site is free to pass the transaction it is already inside — which
 * is what makes the notification commit or abort with the change. See `bus.ts`.
 */
type Queryable = Kysely<Database>;

/**
 * An order moved. Sent to the customer who placed it, the stall making it, and
 * the court's console.
 *
 * `customerId` is nullable because not every order has one at every moment —
 * and a missing customer must not silence the STALL. Dropping the whole event
 * when one recipient is unknown is how a kitchen board goes quiet for a reason
 * nobody can find later.
 */
export async function publishOrderChanged(
  db: Queryable,
  o: {
    orderId: string;
    vendorId: string;
    customerId: string | null;
    foodCourtId: string | null;
  },
): Promise<void> {
  const rooms = [vendorRoom(o.vendorId)];
  if (o.customerId) rooms.push(customerRoom(o.customerId));
  if (o.foodCourtId) rooms.push(courtRoom(o.foodCourtId));

  const message: BusMessage = {
    event: ORDER_CHANGED,
    rooms,
    // Ids only. `rooms.ts` explains why this must never grow a status field.
    payload: { orderId: o.orderId, vendorId: o.vendorId },
  };
  await publish(db, message);
}

/**
 * A stall's menu, stock or open state moved — refetch the catalogue.
 *
 * Goes to the COURT, not to individual customers. Anyone browsing is looking
 * at a list this affects and there is no per-customer scoping to apply: a menu
 * is public to everyone who scanned the QR. The stall's own board hears it too,
 * so a second tablet in the same kitchen updates when the first one edits.
 */
export async function publishCatalogChanged(
  db: Queryable,
  c: { vendorId: string; foodCourtId: string | null },
): Promise<void> {
  const rooms = [vendorRoom(c.vendorId)];
  if (c.foodCourtId) rooms.push(courtRoom(c.foodCourtId));

  await publish(db, {
    event: CATALOG_CHANGED,
    rooms,
    payload: { vendorId: c.vendorId },
  });
}
