import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type Attention, type LiveOrder } from './api';
import { useFallbackInterval, ORDER_CHANGED, useRealtime } from './realtime';
import { Button, Card, EmptyState, ErrorNote, ReasonDialog, Select, Spinner } from './ui';

/**
 * Watch and unstick orders across a court.
 *
 * ============================================================================
 * WHY THIS SCREEN EXISTS
 * ============================================================================
 *
 * Every order here is money the platform is holding on somebody else's behalf.
 * When one stops moving, three parties are stuck at once: a customer waiting
 * for food they paid for, a stall that may not know the order exists, and a
 * platform holding cash it can neither settle nor return.
 *
 * Until now nothing surfaced that. The customer saw a spinner, the kitchen saw
 * nothing, and the console showed stall configuration. Every failure in this
 * product's development was diagnosed by running SQL by hand — the orphaned
 * payment took most of a day, and it was on this list the whole time.
 *
 * THE VERDICT COMES FROM THE SERVER
 *
 * `attention` and `diagnosis` are computed in `order.repository.ts`. This
 * screen renders them and adds nothing. "Stuck" is a claim about money and
 * time, and it has to mean one thing across the worker, this list and the audit
 * log — a client deciding for itself would drift the first time a threshold
 * moved, and drift silently, because both versions would look plausible.
 */

/** How each verdict is presented. Text always states it; colour reinforces. */
const TONE: Record<Attention, { label: string; className: string }> = {
  PAYMENT_ORPHANED: { label: 'Paid, not sent', className: 'bg-held-50 text-held-700' },
  RECONCILIATION: { label: 'Needs a person', className: 'bg-held-50 text-held-700' },
  DISPATCH_FAILED: { label: 'Never arrived', className: 'bg-held-50 text-held-700' },
  STALL_SILENT: { label: 'Stall silent', className: 'bg-draft-50 text-draft-700' },
  UNCOLLECTED: { label: 'Not collected', className: 'bg-draft-50 text-draft-700' },
  SLOW: { label: 'Slow', className: 'bg-draft-50 text-draft-700' },
  OK: { label: 'Moving', className: 'bg-live-50 text-live-700' },
};

function money(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

/** "4m", "1h 12m". Minutes matter here; seconds are noise and hours are rare. */
function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function LiveOrders() {
  /* `FALLBACK_MS` while the socket is up, the old interval when it is not. */
  const fallbackMs = useFallbackInterval();

  const qc = useQueryClient();

  /**
   * Which court. Persisted for the session only.
   *
   * Deliberately NOT remembered across reloads: somebody who opens this screen
   * is responding to something, and quietly showing them a court they last
   * looked at on Tuesday is how an incident gets missed.
   */
  const [courtId, setCourtId] = useState<string>('');
  const [cancelling, setCancelling] = useState<LiveOrder | null>(null);

  const courts = useQuery({ queryKey: ['courts'], queryFn: api.courts });

  const chosen = courtId || courts.data?.courts.find((c) => c.status === 'ACTIVE')?.id || '';
  // The court list carries a live-order count per venue, so it moves too.
  useRealtime(ORDER_CHANGED, [['live-orders', chosen], ['courts']], Boolean(chosen));


  const q = useQuery({
    queryKey: ['live-orders', chosen],
    queryFn: () => api.liveOrders(chosen),
    enabled: Boolean(chosen),
    /*
      Driven by `order.changed` on the COURT room now, which a console operator
      joins from the `fc` claim on their staff token — so this list moves when
      an order moves anywhere in the court, without a court-wide query running
      twelve times a minute per open tab.

      The old note here argued five seconds was justified because "a court with
      two hundred live orders is a heavier query than a stall's dozen". That
      was an argument FOR polling less, not for polling at five seconds, and
      it is the query this change helps most.
    */
    refetchInterval: fallbackMs,
  });

  const cancel = useMutation({
    mutationFn: (v: { orderId: string; reason: string }) =>
      api.forceCancelOrder(chosen, v.orderId, v.reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-orders', chosen] });
      // The court list carries a live-order count per venue.
      void qc.invalidateQueries({ queryKey: ['courts'] });
    },
  });

  const orders = q.data?.orders ?? [];
  const needAttention = orders.filter((o) => o.attention !== 'OK');
  const heldPaise = orders.filter((o) => o.moneyHeld).reduce((n, o) => n + o.totalPayablePaise, 0);

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="display text-[26px] text-ink-900">Live orders</h1>
          <p className="text-[12px] text-ink-500 mt-1">
            Money taken and food not collected. Refreshes on its own.
          </p>
        </div>

        <div className="w-56 shrink-0">
          <Select
            value={chosen}
            onChange={(v) => setCourtId(v)}
            options={(courts.data?.courts ?? []).map((c) => [c.id, c.name] as const)}
            placeholder="Pick a court"
          />
        </div>
      </div>

      {/*
        Two numbers, and the second is the one that matters.
        "Six orders need attention" is a workload. "₹4,180 is held against them"
        is the reason it cannot wait — and it is the number nobody could see
        before this screen existed.
      */}
      {q.data ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
          <Card className="p-4">
            <p className="eyebrow text-[9px] text-ink-500">Needing attention</p>
            <p
              className={`display text-[32px] tnum mt-1.5 leading-none ${
                needAttention.length > 0 ? 'text-held-700' : 'text-ink-900'
              }`}
            >
              {needAttention.length}
            </p>
            <p className="text-[11px] text-ink-500 mt-1.5">of {orders.length} live</p>
          </Card>

          <Card className="p-4">
            <p className="eyebrow text-[9px] text-ink-500">Money held</p>
            <p className="display text-[32px] tnum mt-1.5 leading-none text-ink-900">
              {money(heldPaise)}
            </p>
            <p className="text-[11px] text-ink-500 mt-1.5">not yet settled or returned</p>
          </Card>
        </div>
      ) : null}

      {q.isLoading ? <Spinner label="Reading the court…" /> : null}
      {q.isError ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      {cancel.isError ? (
        <div className="mb-4">
          <ErrorNote error={cancel.error} />
        </div>
      ) : null}

      {q.data && orders.length === 0 ? (
        <EmptyState
          title="Nothing in flight"
          body="Every order in this court has been collected, cancelled or refunded. This list fills up on its own."
        />
      ) : null}

      {orders.length > 0 ? (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-ink-100">
            {orders.map((o) => {
              const tone = TONE[o.attention];
              return (
                <li key={o.orderId} className="p-4">
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="ident text-[14px] font-bold text-ink-900">
                          {o.orderNumber}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold ${tone.className}`}
                        >
                          <span aria-hidden className="size-1.5 rounded-full bg-current" />
                          {tone.label}
                        </span>
                        {/* The database word, for anyone cross-referencing a
                            query or an audit row. Same convention as StatusPill. */}
                        <span className="ident text-[10px] text-ink-400">{o.status}</span>
                      </div>

                      <p className="text-[13px] text-ink-700 mt-1.5">
                        {o.vendorName}
                        {o.customerName ? (
                          <>
                            {' ·'}
                            <span className="text-ink-500">{o.customerName}</span>
                          </>
                        ) : null}
                      </p>

                      {/* The server's sentence, verbatim. It is the most useful
                          thing on the row and paraphrasing it here would put a
                          second version of the truth in the product. */}
                      {o.attention !== 'OK' ? (
                        <p className="text-[12px] text-ink-500 mt-1.5 leading-relaxed max-w-prose">
                          {o.diagnosis}
                        </p>
                      ) : null}
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-[14px] font-bold text-ink-900 tnum">
                        {money(o.totalPayablePaise)}
                      </p>
                      <p className="text-[11px] text-ink-500 tnum mt-0.5">{age(o.ageSeconds)} ago</p>
                      <p className="text-[11px] mt-0.5">
                        {o.moneyHeld ? (
                          <span className="text-live-700 font-semibold">held</span>
                        ) : (
                          <span className="text-ink-400">{o.paymentStatus ?? 'no payment'}</span>
                        )}
                      </p>
                    </div>

                    <div className="shrink-0">
                      <Button
                        variant="danger"
                        disabled={cancel.isPending}
                        onClick={() => setCancelling(o)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {cancelling ? (
        <ReasonDialog
          title={`Cancel ${cancelling.orderNumber}?`}
          prompt={`${cancelling.vendorName} · ${money(cancelling.totalPayablePaise)}`}
          /*
            The consequence differs by whether money is actually held, and
            getting that wrong in either direction is bad: promising a refund
            that will not happen, or failing to mention one that will.
            `cancelRefunds` is the server's answer, not a guess from the status.
          */
          consequence={
            cancelling.cancelRefunds
              ? 'The customer is refunded automatically — cancelling is what starts it. The stall stops seeing this order.'
              : 'No money is held against this order, so there is nothing to refund. The order simply stops.'
          }
          confirmLabel="Cancel the order"
          tone="danger"
          pending={cancel.isPending}
          onCancel={() => setCancelling(null)}
          onConfirm={(reason) => {
            cancel.mutate({ orderId: cancelling.orderId, reason });
            setCancelling(null);
          }}
        />
      ) : null}
    </div>
  );
}
