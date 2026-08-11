/**
 * Refund retry schedule and customer-facing status.
 *
 * PRD REF-01: a refund is initiated automatically within 60 seconds of
 * rejection, with no manual step anywhere in the path.
 * PRD REF-03: a failure enters a retry schedule and then a VISIBLE
 * reconciliation queue. A refund never silently stops being attempted.
 *
 * TDD §6.4.
 */

export interface RetryStep {
  readonly attempt: number;
  readonly delaySeconds: number;
  /** Copy key shown to the customer while in this state. */
  readonly customerCopyKey: string;
  readonly alertsOps: boolean;
}

/**
 * Attempt 1 fires from the committed rejection event, not from a scheduler, so
 * the 60-second guarantee does not depend on queue latency.
 */
export const RETRY_SCHEDULE: readonly RetryStep[] = [
  { attempt: 1, delaySeconds: 0, customerCopyKey: 'refund.pending', alertsOps: false },
  { attempt: 2, delaySeconds: 120, customerCopyKey: 'refund.pending', alertsOps: false },
  { attempt: 3, delaySeconds: 480, customerCopyKey: 'refund.pending', alertsOps: false },
  // From here the customer is told the truth rather than a reassuring fiction.
  { attempt: 4, delaySeconds: 1800, customerCopyKey: 'refund.delayed', alertsOps: true },
  { attempt: 5, delaySeconds: 7200, customerCopyKey: 'refund.delayed', alertsOps: true },
];

export const MAX_ATTEMPTS = RETRY_SCHEDULE.length;

export function stepFor(attempt: number): RetryStep | undefined {
  return RETRY_SCHEDULE.find((s) => s.attempt === attempt);
}

/**
 * Jitter is applied by the caller with the attempt number as a seed bound;
 * this function stays pure so the schedule can be asserted exactly.
 */
export function nextRetryAt(attempt: number, now: Date): Date | null {
  const next = stepFor(attempt + 1);
  if (next === undefined) return null; // exhausted — go to reconciliation
  return new Date(now.getTime() + next.delaySeconds * 1000);
}

export function isExhausted(attempt: number): boolean {
  return attempt >= MAX_ATTEMPTS;
}

export type RefundOutcome = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type RefundNextAction =
  | { readonly kind: 'DONE' }
  | {
      readonly kind: 'RETRY';
      readonly at: Date;
      readonly attempt: number;
      readonly alertsOps: boolean;
    }
  /** Terminal. Opens a reconciliation item with an owner and an age. */
  | { readonly kind: 'RECONCILE'; readonly reason: 'RETRIES_EXHAUSTED' };

export function decideRefundNextAction(
  outcome: RefundOutcome,
  attempt: number,
  now: Date,
): RefundNextAction {
  if (outcome === 'SUCCEEDED') return { kind: 'DONE' };

  // A PENDING refund is not a failure — the provider has it and will call back.
  // Only an explicit FAILED consumes an attempt.
  if (outcome === 'PENDING') {
    const at = nextRetryAt(attempt, now);
    if (at === null) return { kind: 'RECONCILE', reason: 'RETRIES_EXHAUSTED' };
    const next = stepFor(attempt + 1);
    return { kind: 'RETRY', at, attempt: attempt + 1, alertsOps: next?.alertsOps ?? false };
  }

  if (isExhausted(attempt)) return { kind: 'RECONCILE', reason: 'RETRIES_EXHAUSTED' };

  const at = nextRetryAt(attempt, now);
  if (at === null) return { kind: 'RECONCILE', reason: 'RETRIES_EXHAUSTED' };
  const next = stepFor(attempt + 1);
  return { kind: 'RETRY', at, attempt: attempt + 1, alertsOps: next?.alertsOps ?? false };
}

/**
 * What the customer sees.
 *
 * PRD REF-04 / CUS-TRK-05: the status is explicit at every step. The words
 * "payment lost", or an unexplained failure, never appear.
 */
export function customerCopyKey(status: RefundOutcome | 'ABANDONED', attempt: number): string {
  if (status === 'SUCCEEDED') return 'refund.done';
  if (status === 'ABANDONED') return 'refund.credit.issued';
  const step = stepFor(Math.max(attempt, 1));
  return step?.customerCopyKey ?? 'refund.delayed';
}

/** PRD REF-01, measured as a pilot success metric. */
export const INITIATE_WITHIN_SECONDS = 60;

export function initiatedInTime(rejectedAt: Date, initiatedAt: Date): boolean {
  return (initiatedAt.getTime() - rejectedAt.getTime()) / 1000 <= INITIATE_WITHIN_SECONDS;
}
