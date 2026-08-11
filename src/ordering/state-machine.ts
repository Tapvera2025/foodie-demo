/**
 * The order state machine.
 *
 * PRD ORD-SM-01: no API sets an order status directly. Transitions happen only
 * through named commands that validate the current state and the actor's
 * permission, take a row lock, and append to `order_status_history` in the same
 * transaction.
 *
 * This module is the pure half — the allow-list and the guards. The persistence
 * half lands with the order service; keeping the rules here means they can be
 * enumerated exhaustively in a test rather than inferred from controllers.
 *
 * TDD §7.
 */

import { AppError } from '../platform/errors.js';
import type { Permission } from '../identity/permissions.js';

export const ORDER_STATUSES = [
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
  'RECONCILIATION_REQUIRED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The complete transition allow-list. Anything not listed is forbidden.
 *
 * Note `ACKNOWLEDGED -> READY` is permitted: a stall selling packaged drinks or
 * pre-made items may go straight to ready without a preparing step.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  CREATED: ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'RECONCILIATION_REQUIRED'],
  PAYMENT_CONFIRMED: ['DISPATCHED', 'RECONCILIATION_REQUIRED'],
  DISPATCHED: ['ACKNOWLEDGED', 'DISPATCH_FAILED', 'REJECTED'],
  ACKNOWLEDGED: ['PREPARING', 'READY', 'REJECTED'],
  PREPARING: ['READY', 'REJECTED'],
  READY: ['COMPLETED'],
  DISPATCH_FAILED: ['DISPATCHED', 'CANCELLED', 'REJECTED'],
  REJECTED: ['REFUND_PENDING'],
  CANCELLED: ['REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED', 'REFUND_FAILED'],
  REFUND_FAILED: ['REFUND_PENDING', 'RECONCILIATION_REQUIRED'],
  RECONCILIATION_REQUIRED: ['PAYMENT_CONFIRMED', 'REFUND_PENDING', 'CANCELLED', 'COMPLETED'],

  // Terminal.
  COMPLETED: [],
  PAYMENT_FAILED: [],
  REFUNDED: [],
};

export function isTerminal(status: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * An illegal transition is a logged, alerted error — never a silent no-op and
 * never a forced write. PRD ORD-SM-01.
 */
export function assertTransitionAllowed(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError('INVALID_TRANSITION', `cannot move an order from ${from} to ${to}`, {
      from,
      to,
    });
  }
}

/** States in which a vendor may still reject. PRD KDS-REJ-01. */
export function isRejectable(status: OrderStatus): boolean {
  return canTransition(status, 'REJECTED');
}

/** Money has been committed — a customer has been charged. */
export function isPaid(status: OrderStatus): boolean {
  return status !== 'CREATED' && status !== 'PAYMENT_PENDING' && status !== 'PAYMENT_FAILED';
}

export const ORDER_COMMANDS = [
  'createOrder',
  'beginPayment',
  'confirmPayment',
  'failPayment',
  'dispatch',
  'acknowledge',
  'markPreparing',
  'markReady',
  'markCompleted',
  'reject',
  'customerCancel',
  'forceCancel',
  'failDispatch',
  'beginRefund',
  'confirmRefund',
  'failRefund',
  'flagReconciliation',
] as const;

export type OrderCommand = (typeof ORDER_COMMANDS)[number];

export interface CommandSpec {
  readonly to: OrderStatus;
  /** Undefined means the command is system-initiated and carries no user permission. */
  readonly permission?: Permission;
  readonly requiresReason: boolean;
}

/**
 * Every command, its target state and the permission it needs.
 *
 * PRD RBAC-02: adding a command without a permission entry is a compile error,
 * and a test asserts every permission named here exists in the matrix.
 */
export const COMMAND_SPECS: Readonly<Record<OrderCommand, CommandSpec>> = {
  createOrder: { to: 'CREATED', permission: 'order.create', requiresReason: false },
  beginPayment: { to: 'PAYMENT_PENDING', requiresReason: false },
  confirmPayment: { to: 'PAYMENT_CONFIRMED', requiresReason: false },
  failPayment: { to: 'PAYMENT_FAILED', requiresReason: false },
  dispatch: { to: 'DISPATCHED', requiresReason: false },

  // A machine event, not a human approval. Only a paired device emits it.
  acknowledge: { to: 'ACKNOWLEDGED', permission: 'order.acknowledge', requiresReason: false },

  markPreparing: { to: 'PREPARING', permission: 'order.prepare', requiresReason: false },
  markReady: { to: 'READY', permission: 'order.ready', requiresReason: false },
  markCompleted: { to: 'COMPLETED', permission: 'order.complete', requiresReason: false },

  // Reason is mandatory: it is stored, reportable, and drives the vendor
  // rejection-rate metric. PRD KDS-REJ-02.
  reject: { to: 'REJECTED', permission: 'order.reject', requiresReason: true },

  customerCancel: { to: 'CANCELLED', permission: 'order.cancel.self', requiresReason: false },
  forceCancel: { to: 'CANCELLED', permission: 'order.force_cancel', requiresReason: true },

  failDispatch: { to: 'DISPATCH_FAILED', requiresReason: false },
  beginRefund: { to: 'REFUND_PENDING', requiresReason: false },
  confirmRefund: { to: 'REFUNDED', requiresReason: false },
  failRefund: { to: 'REFUND_FAILED', requiresReason: false },
  flagReconciliation: { to: 'RECONCILIATION_REQUIRED', requiresReason: true },
};

export interface TransitionRequest {
  readonly command: OrderCommand;
  readonly from: OrderStatus;
  readonly reason?: string;
}

/**
 * Validates a command against the current state. Does not perform it — the
 * caller owns the row lock and the history append.
 */
export function assertCommandAllowed(req: TransitionRequest): OrderStatus {
  const spec = COMMAND_SPECS[req.command];

  if (spec.requiresReason && (req.reason === undefined || req.reason.trim() === '')) {
    throw new AppError('INVALID_TRANSITION', `${req.command} requires a reason`);
  }

  // createOrder has no prior state; every other command must be a legal move.
  if (req.command !== 'createOrder') {
    assertTransitionAllowed(req.from, spec.to);
  }

  return spec.to;
}

/**
 * States a paid order can be in where nobody has confirmed the kitchen has it.
 * The escalation ladder watches exactly this. PRD §11.4.
 */
export function isAwaitingAcknowledgement(status: OrderStatus): boolean {
  return status === 'DISPATCHED';
}
