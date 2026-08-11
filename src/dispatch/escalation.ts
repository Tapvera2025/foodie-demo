/**
 * The dispatch escalation ladder.
 *
 * This module is why removing the vendor accept click was defensible rather
 * than reckless. `SENT_TO_VENDOR` used to assert something we had no evidence
 * for: that a human or a device on the other end had actually received the
 * order. Tablet asleep, printer out of paper, court wi-fi dropped — and the
 * customer has paid for food nobody is cooking.
 *
 * The ladder closes that hole. Thresholds are per-court configuration; the
 * defaults below are the pilot starting point.
 *
 * PRD §11.4, ESC-01..04. TDD §9.2.
 */

import type { OrderStatus } from '../ordering/state-machine.js';

export type LadderAction =
  | 'RETRY_DISPATCH'
  | 'RETRY_DISPATCH_AND_ALARM'
  | 'BLOCK_VENDOR_AND_ALERT_MANAGER'
  | 'FAIL_DISPATCH_AND_OFFER_CANCEL';

export interface LadderRung {
  readonly step: number;
  readonly atSeconds: number;
  readonly action: LadderAction;
  /** Whether the customer's view changes at this rung. */
  readonly customerVisible: boolean;
}

export interface LadderConfig {
  readonly step1Seconds: number;
  readonly step2Seconds: number;
  readonly step3Seconds: number;
  readonly step4Seconds: number;
}

export const DEFAULT_LADDER: LadderConfig = {
  step1Seconds: 15,
  step2Seconds: 45,
  step3Seconds: 90,
  step4Seconds: 180,
};

export function buildLadder(cfg: LadderConfig = DEFAULT_LADDER): readonly LadderRung[] {
  return [
    { step: 1, atSeconds: cfg.step1Seconds, action: 'RETRY_DISPATCH', customerVisible: false },
    {
      step: 2,
      atSeconds: cfg.step2Seconds,
      action: 'RETRY_DISPATCH_AND_ALARM',
      customerVisible: false,
    },
    {
      step: 3,
      atSeconds: cfg.step3Seconds,
      // The vendor stops receiving NEW orders until they acknowledge the one
      // they are sitting on. The customer still sees a neutral "order placed" —
      // ESC-02: customer-facing copy never blames the stall.
      action: 'BLOCK_VENDOR_AND_ALERT_MANAGER',
      customerVisible: false,
    },
    {
      step: 4,
      atSeconds: cfg.step4Seconds,
      // One tap, full refund, no support contact needed. ESC-03.
      action: 'FAIL_DISPATCH_AND_OFFER_CANCEL',
      customerVisible: true,
    },
  ];
}

export type LadderDecision =
  /** The order moved on. Cancel the ladder and unblock the vendor. */
  | { readonly kind: 'CANCEL'; readonly unblockVendor: boolean }
  /** Run this rung, then schedule the next. */
  | {
      readonly kind: 'RUN';
      readonly rung: LadderRung;
      readonly nextRunAt: Date | null;
    };

/**
 * Decides what to do when a scheduled escalation step fires.
 *
 * The status check is first and unconditional: by the time a delayed job runs,
 * the order has very often already been acknowledged. ESC-01 requires the
 * ladder to be durable, which means every rung must tolerate arriving late.
 */
export function decideLadderStep(input: {
  readonly orderStatus: OrderStatus;
  readonly step: number;
  readonly dispatchedAt: Date;
  readonly now: Date;
  readonly config?: LadderConfig;
}): LadderDecision {
  const ladder = buildLadder(input.config ?? DEFAULT_LADDER);

  // Acknowledged, rejected, cancelled — anything but still waiting.
  if (input.orderStatus !== 'DISPATCHED') {
    return { kind: 'CANCEL', unblockVendor: input.step >= 3 };
  }

  const rung = ladder.find((r) => r.step === input.step);
  if (rung === undefined) {
    // Past the last rung. The order is already DISPATCH_FAILED by now.
    return { kind: 'CANCEL', unblockVendor: false };
  }

  const next = ladder.find((r) => r.step === input.step + 1);
  const nextRunAt =
    next === undefined ? null : new Date(input.dispatchedAt.getTime() + next.atSeconds * 1000);

  return { kind: 'RUN', rung, nextRunAt };
}

/** When the first rung should fire, scheduled at dispatch time. */
export function firstRunAt(dispatchedAt: Date, cfg: LadderConfig = DEFAULT_LADDER): Date {
  return new Date(dispatchedAt.getTime() + cfg.step1Seconds * 1000);
}

/**
 * Whether the customer may cancel with a full refund.
 *
 * True only once the ladder has reached the final rung. At any other time the
 * cancel endpoint returns 409 — PRD ESC-03 and the `order.cancel.self`
 * conditional grant in the RBAC matrix.
 */
export function cancellationOffered(
  orderStatus: OrderStatus,
  dispatchedAt: Date | null,
  now: Date,
  cfg: LadderConfig = DEFAULT_LADDER,
): boolean {
  if (orderStatus === 'DISPATCH_FAILED') return true;
  if (orderStatus !== 'DISPATCHED' || dispatchedAt === null) return false;
  const elapsed = (now.getTime() - dispatchedAt.getTime()) / 1000;
  return elapsed >= cfg.step4Seconds;
}

/**
 * Config validation. A ladder that does not strictly increase can block a
 * vendor before the first redispatch has even been attempted.
 */
export function isValidLadder(cfg: LadderConfig): boolean {
  return (
    cfg.step1Seconds > 0 &&
    cfg.step2Seconds > cfg.step1Seconds &&
    cfg.step3Seconds > cfg.step2Seconds &&
    cfg.step4Seconds > cfg.step3Seconds
  );
}

/** Copy shown while the ladder is running. ESC-02 — never blames the vendor. */
export const LADDER_COPY = {
  /** Steps 1–3: the customer sees no change at all. */
  running: 'order.placed.body',
  /** Step 4. */
  cancelOffered: 'order.delayed.cancel_offer',
} as const;
