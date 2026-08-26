/**
 * ============================================================================
 * WHO IS ALLOWED TO HEAR WHAT
 * ============================================================================
 *
 * The entire tenancy surface of the realtime layer is this file, and it is
 * deliberately pure: no Socket.IO, no database, no config. That means the rule
 * can be tested exhaustively without booting anything, and it means there is
 * exactly ONE place to read to answer "can a customer receive somebody else's
 * order events".
 *
 * ----------------------------------------------------------------------------
 * THE PROPERTY THAT MATTERS: THE CLIENT NEVER NAMES A ROOM
 * ----------------------------------------------------------------------------
 *
 * The obvious design is a `subscribe` message — the client says "I want order
 * abc123" and the server checks whether it may have it. That is one forgotten
 * check away from a customer subscribing to a stranger's order, and the check
 * lives in a message handler where it is easy to add a second entry point that
 * skips it.
 *
 * So there is no subscribe message. `roomsFor` derives the complete room list
 * from the VERIFIED TOKEN at handshake, the gateway joins exactly those, and
 * the socket never accepts a room name from the wire at all. A client asking
 * for another customer's events has nothing to ask WITH.
 *
 * That is the same shape as PRD §16.3 / TENANT-01 on the HTTP side, where a
 * tenancy mismatch is scoped in the query rather than checked after it: a read
 * that fetches and then decides is one refactor away from returning the row.
 *
 * ----------------------------------------------------------------------------
 * WHY ORDER EVENTS GO TO A CUSTOMER ROOM AND NOT AN ORDER ROOM
 * ----------------------------------------------------------------------------
 *
 * `order:<id>` would be the natural name, and it is the wrong one. A socket
 * connects before it knows which orders the person has, and orders are created
 * DURING the connection — so an order-keyed room means the client must join
 * rooms as it learns of them, which puts room names back on the wire and
 * reintroduces exactly the problem above.
 *
 * `customer:<id>` is knowable at handshake, covers every order that customer
 * will ever have including ones placed a second from now, and needs no further
 * messages. The event payload carries the order id so the client knows what to
 * refetch.
 */

/** A verified identity, already checked by the handshake. Never built from wire data. */
export type Principal =
  | { readonly kind: 'customer'; readonly customerId: string }
  | {
      readonly kind: 'staff';
      readonly staffId: string;
      /** From the token's role claims — the stalls this person may act for. */
      readonly vendorIds: readonly string[];
      /** Court-scoped roles (a console operator, an area manager). */
      readonly courtIds: readonly string[];
    };

export const customerRoom = (customerId: string): string => `customer:${customerId}`;
export const vendorRoom = (vendorId: string): string => `vendor:${vendorId}`;
export const courtRoom = (courtId: string): string => `court:${courtId}`;

/**
 * Every room this principal may occupy, and no others.
 *
 * Empty is a legitimate answer — a staff token whose roles name neither a
 * vendor nor a court has nothing to listen to. The gateway treats an empty
 * list as a connection that stays open and hears nothing, rather than an
 * error: a role that grants no realtime scope is a configuration question, not
 * a reason to break a working console.
 */
export function roomsFor(p: Principal): string[] {
  if (p.kind === 'customer') return [customerRoom(p.customerId)];

  /*
   * `Set`, because a staff member with two roles at the same stall — say
   * VENDOR_MANAGER and VENDOR_STAFF — would otherwise join the same room
   * twice. Socket.IO tolerates that, but a duplicated room makes the room list
   * useless as evidence in a log line or a test.
   */
  const rooms = new Set<string>();
  for (const v of p.vendorIds) rooms.add(vendorRoom(v));
  for (const c of p.courtIds) rooms.add(courtRoom(c));
  return [...rooms];
}

/**
 * The events the server publishes. A closed set, on purpose.
 *
 * PRD §11.4: an event INVALIDATES AND TRIGGERS A REFETCH; it never writes
 * client state directly, because event ordering is not guaranteed and a client
 * that derives state from a sequence will eventually be wrong.
 *
 * The payload therefore carries identifiers and nothing else — no status, no
 * totals, no item list. That is not minimalism for its own sake: a payload
 * carrying a status is a payload a client will eventually render, and the
 * moment it does, a reordered or replayed event shows a customer a state their
 * order has already left. Giving the client nothing to render makes the wrong
 * thing impossible rather than discouraged.
 */
export interface OrderEvent {
  readonly orderId: string;
  /** So a board can ignore an order for a stall it is not showing. */
  readonly vendorId: string;
}

export const ORDER_CHANGED = 'order.changed' as const;

/** A stall's menu, stock or open/closed state moved. Refetch the catalogue. */
export interface CatalogEvent {
  readonly vendorId: string;
}

export const CATALOG_CHANGED = 'catalog.changed' as const;
