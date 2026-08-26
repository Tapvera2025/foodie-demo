import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';

import { api, type OrderView } from '../lib/api';
import { formatINR } from '../lib/money';
import { useCart } from '../lib/cart';
import { useOrderNotifications } from '../lib/notify';
import { useFallbackInterval, ORDER_CHANGED, useRealtime } from '../lib/realtime';
import { BottomBar, Card, ErrorState, Screen, Spinner } from './ui';

/**
 * The customer-visible journey. Internal states collapse onto these five.
 *
 * Labels are one word each because they are set side by side under a horizontal
 * rail on a 360px screen. "Ready to collect" and "Being made" were fine stacked
 * vertically and wrap to two lines here, which turns a clean rail into a ragged
 * block. That constraint got tighter when COLLECTED became its own step — see
 * the label styling in the rail below.
 *
 * ---------------------------------------------------------------------------
 * WHY COLLECTED IS A STEP AND NOT THE END OF `Ready`
 * ---------------------------------------------------------------------------
 *
 * It used to share index 3 with READY, so a collected order sat forever on a
 * rail whose last node was still the RED in-progress dot, under a headline
 * reading "Collected". The screen said the journey was over and the rail said
 * it was still waiting on you — and the rail is the thing people read first.
 *
 * Red on this rail means "not done, and something still has to happen". After
 * collection nothing does, so nothing may be red.
 */
const STEPS = [
  { label: 'Received', headline: 'Order received', hint: 'We have your order' },
  { label: 'Confirmed', headline: 'The stall has your order', hint: 'It is in their queue' },
  { label: 'Preparing', headline: 'Preparing your food', hint: 'In the kitchen now' },
  { label: 'Ready', headline: 'Ready to collect', hint: 'Go to the counter' },
  { label: 'Collected', headline: 'Collected', hint: 'Enjoy your food.' },
] as const;

/**
 * Where this status sits on the forward rail, or NULL if it is not on it.
 *
 * ---------------------------------------------------------------------------
 * `default: return 0` WAS A SILENT LIE, AND THIS IS THE FIX
 * ---------------------------------------------------------------------------
 *
 * This used to end in `default: return 0`, so EVERY status the switch does not
 * name rendered as "RECEIVED" with a red dot and "This updates by itself. You
 * can put your phone away." underneath.
 *
 * The statuses that fall through are not obscure ones. `DISPATCH_FAILED`,
 * `REFUNDED`, and anything added server-side after this file was last edited
 * all landed on step zero. A customer whose order had failed to reach the
 * kitchen was told it had been received and invited to put their phone away.
 *
 * It is the worst shape of bug this screen can have: no error, no blank space,
 * no clue — a confident wrong answer, in the largest element on the page,
 * about the one thing the customer opened the app to find out.
 *
 * `null` instead. The caller must decide what to draw for a status this rail
 * cannot place, and TypeScript makes it decide rather than letting the
 * question go unasked. Nothing here guesses.
 */
function stepIndex(status: string): number | null {
  switch (status) {
    case 'CREATED':
    case 'PAYMENT_PENDING':
      return 0;
    case 'PAYMENT_CONFIRMED':
    case 'DISPATCHED':
      return 1;
    // Accepted and cooking are one tap on the board now, so they are one step
    // here. A customer told "accepted" and then "being made" four seconds
    // apart learns nothing from the first message.
    case 'ACKNOWLEDGED':
    case 'PREPARING':
      return 2;
    case 'READY':
      return 3;
    case 'COLLECTED':
      return 4;
    default:
      // REJECTED, CANCELLED and REFUNDED have their own rail; DISPATCH_FAILED
      // and the payment failures have their own cards. Anything else is a
      // status this build has never heard of, and saying nothing beats saying
      // "Received".
      return null;
  }
}

/**
 * Nothing further will happen to this order, so stop asking.
 *
 * REFUND_PENDING is deliberately ABSENT: a refund in flight is the one thing
 * on this screen that is still moving, and it is exactly what the customer is
 * waiting on by then. REFUND_FAILED is absent for the opposite reason — it
 * needs a human, and a screen that stopped polling would never notice them
 * fixing it.
 */
const TERMINAL = new Set([
  'COLLECTED',
  'REJECTED',
  'CANCELLED',
  'REFUNDED',
  'PAYMENT_EXPIRED',
]);

/**
 * ============================================================================
 * THE REJECTED JOURNEY, WHICH IS STILL A JOURNEY
 * ============================================================================
 *
 * A rejected order used to get no rail at all — the refund card replaced it,
 * on the reasoning that "collection is the only ending that belongs on a
 * progress rail, because it is the only one that is progress".
 *
 * That was wrong about what the rail is for. It is not a record of success; it
 * is the answer to "where is my order and what happens next", and that
 * question is MORE pressing when the answer is bad. Deleting the rail at the
 * moment things go wrong takes away the one element on the screen that had
 * been orienting the customer, and leaves prose to do a job a diagram was
 * doing better.
 *
 * Three steps, because there are exactly three things that happen and each is
 * a fact the system holds rather than a reassurance:
 *
 *   Received   it did happen, and it is not undone by what followed
 *   Rejected   the stall said no — or the order was cancelled
 *   Refunded   the money went back, or is on its way
 *
 * The middle step is deliberately NOT a green tick. It completed, but a tick
 * would say it went well.
 */
const REJECTED_STEPS = ['Received', 'Rejected', 'Refunded'] as const;
const CANCELLED_STEPS = ['Received', 'Cancelled', 'Refunded'] as const;

/** How a single node on a rail is drawn. */
type NodeTone =
  /** Finished, and finished well. Green, ticked. */
  | 'done'
  /** Happening now, waiting on something. Brand red, hollow dot. */
  | 'active'
  /** Finished, and it is bad news. Alert red, crossed. */
  | 'bad'
  /** Not reached. */
  | 'pending';

/**
 * ============================================================================
 * ONE RAIL, TWO JOURNEYS
 * ============================================================================
 *
 * Extracted rather than copied. The alternative was a second rail beside the
 * first with its own hard-coded percentages, and the geometry here is exactly
 * the kind that drifts: the track inset, the fill span and the column width
 * are three numbers that have to agree, and a comment on the original warned
 * that "changing the number of steps again means revisiting these two numbers
 * along with the fill's 80".
 *
 * So they are no longer written down. `half` is the centre of the first
 * column, the track runs from there to its mirror, and the fill covers that
 * same span — all derived from `steps.length`. A rail with three steps and one
 * with five are now the same code with a different array, and neither can be
 * misaligned by editing the other.
 *
 * Inline styles rather than Tailwind classes for those three, because
 * `left-[16.666%]` is not a class Tailwind can generate from a computed value
 * anyway, and a percentage that must be arithmetic belongs in arithmetic.
 */
function Rail({
  ariaLabel,
  steps,
  toneAt,
  fillTo,
  fillClass,
}: {
  ariaLabel: string;
  steps: readonly string[];
  toneAt: (i: number) => NodeTone;
  /** Index the coloured line reaches. */
  fillTo: number;
  /** Tailwind background for that line — the journey's colour, not a node's. */
  fillClass: string;
}) {
  const n = steps.length;
  // Centre of the first column, in percent. The last is its mirror.
  const half = 100 / n / 2;
  const span = 100 - 2 * half;

  return (
    <ol className="relative flex justify-between" aria-label={ariaLabel}>
      <span
        aria-hidden
        className="absolute top-3 h-0.5 -translate-y-1/2 bg-ink-200"
        style={{ left: `${half}%`, right: `${half}%` }}
      />
      <span
        aria-hidden
        className={`absolute top-3 h-0.5 -translate-y-1/2 transition-[width] duration-500 ${fillClass}`}
        style={{
          left: `${half}%`,
          // 0 at the first step, the full span at the last.
          width: `${n > 1 ? (Math.max(0, Math.min(fillTo, n - 1)) / (n - 1)) * span : 0}%`,
        }}
      />

      {steps.map((label, i) => {
        const tone = toneAt(i);

        return (
          <li
            key={label}
            className="relative z-10 flex flex-col items-center"
            style={{ width: `${100 / n}%` }}
          >
            <span
              aria-hidden
              className={`size-6 rounded-full grid place-items-center text-[11px] font-bold
                          ring-4 ring-surface ${
                            tone === 'done'
                              ? /* `banner-ready`, not `fresh-500`: white on
                                   #1BA55C is 3.19:1 and this tick is 11px. */
                                'bg-banner-ready text-on-banner'
                              : tone === 'bad'
                                ? /* `on-brand`, NOT `on-banner`. Both are white
                                     in the light theme, but the dark theme
                                     flips `alert-500` to a bright #ff5a4e where
                                     white measures 3.08:1 — under AA for an
                                     11px glyph. `on-brand` is the token that
                                     already inverts for exactly this reason,
                                     and the contrast suite caught the
                                     difference. */
                                  'bg-alert-500 text-on-brand'
                                : tone === 'active'
                                  ? 'bg-brand-fill text-on-brand'
                                  : 'bg-ink-200 text-ink-400'
                          }`}
            >
              {tone === 'done' ? '✓' : tone === 'bad' ? '✕' : ''}
              {tone === 'active' ? <span className="size-2 rounded-full bg-on-brand" /> : null}
            </span>

            {/*
              `whitespace-nowrap` and reduced tracking, together, are what buy
              the fifth column.

              A 360px screen leaves about 288px inside this card, so a column
              went from 72px to 57px when COLLECTED was added. "CONFIRMED",
              "PREPARING" and "COLLECTED" are each nine uppercase characters
              and at `.eyebrow`'s 0.09em they measure right at that limit —
              near enough that a font substitution decides it.

              If one wraps, the rail becomes a ragged two-line block, and it
              wraps unevenly because "READY" never would. Overlapping
              neighbours by a hair is the better of the two failures, so the
              labels are forbidden to wrap and the tracking is pulled back to
              0.045em to make that unnecessary. Tracking is halved rather than
              dropped: these are single short words, where it is doing much
              less work than in the running eyebrow text `.eyebrow` was
              written for.

              The three-step rail has far more room per column and does not
              need this — but it costs nothing there, and one rule is easier to
              keep true than two.
            */}
            <span
              className={`eyebrow text-[9px] tracking-[0.045em] whitespace-nowrap
                          mt-2.5 text-center ${
                            tone === 'active'
                              ? 'text-brand-700'
                              : tone === 'bad'
                                ? 'text-alert-500'
                                : tone === 'done'
                                  ? 'text-ink-700'
                                  : 'text-ink-400'
                          }`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Track() {
  /* `FALLBACK_MS` while the socket is up, the old interval when it is not. */
  const fallbackMs = useFallbackInterval();

  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const setVendor = useCart((s) => s.setVendor);
  const [showDetails, setShowDetails] = useState(false);

  /**
   * SOCKETS NOW, WITH THE POLL DEMOTED TO INSURANCE.
   *
   * The note that used to sit here said polling was "the degenerate case of
   * the right design, not a shortcut that has to be undone", and that turned
   * out to be exactly true — this query did not change shape. The socket
   * handler calls `invalidateQueries(['order', orderId])` and this refetches,
   * which is what it always did on a timer.
   *
   * PRD CUS-TRK-04 is what makes that possible: the client re-fetches
   * authoritative state rather than deriving it from events, so an event is
   * only ever a hint about WHEN to ask, never an answer.
   *
   * 4s -> `FALLBACK_MS`. What remains is not a poll in the old sense; it is
   * cover for a socket that has died without saying so, which a client cannot
   * otherwise detect. `lib/realtime.ts` sets out why that case is real and why
   * a customer at a counter must not be the one to discover it.
   *
   * Still stops at TERMINAL. A collected or refunded order has nothing further
   * to report, and asking anyway is the waste this change is about.
   */
  const q = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.order(orderId!),
    enabled: Boolean(orderId),
    refetchInterval: (query) => {
      const data = query.state.data as OrderView | undefined;
      return data && TERMINAL.has(data.status) ? false : fallbackMs;
    },
  });

  /*
   * The order this screen shows, plus the customer's order list — the badge
   * and the "your orders" screen are looking at the same underlying change,
   * and letting them go stale is how a customer sees two different answers on
   * two screens of the same app.
   */
  useRealtime(ORDER_CHANGED, [['order', orderId], ['session-orders']], Boolean(orderId));

  /**
   * One order, same diff. `useOrderNotifications` takes a list, so this passes
   * a list of one rather than growing a second code path for the singular case
   * — two implementations of "did the status change" is two chances to
   * disagree about it.
   */
  const watched = useMemo(
    () =>
      q.data
        ? [
            {
              orderId: q.data.orderId,
              orderNumber: q.data.orderNumber,
              status: q.data.status,
              vendorName: q.data.vendorName,
            },
          ]
        : undefined,
    [q.data],
  );
  useOrderNotifications(watched);

  const cancel = useMutation({
    mutationFn: () => api.cancelOrder(orderId!),
    onSuccess: () => void q.refetch(),
  });

  if (q.isLoading) {
    return (
      <Screen title="Your order">
        <Spinner label="Loading your order…" />
      </Screen>
    );
  }
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const o = q.data;
  const current = stepIndex(o.status);
  /**
   * ==========================================================================
   * THE WHOLE REFUND LIFECYCLE, NOT JUST THE MOMENT OF REJECTION
   * ==========================================================================
   *
   * This was `REJECTED || CANCELLED`, and that is a list of two out of five.
   * `OrderStatus` continues:
   *
   *     REJECTED -> REFUND_PENDING -> REFUNDED     (or REFUND_FAILED)
   *
   * The worker moves an order to REFUND_PENDING within seconds of the stall
   * rejecting it. So the customer saw the toast fire on REJECTED — and then
   * the screen fell out of every branch it had, because REFUND_PENDING is not
   * in this list, not on the forward rail, and not in TERMINAL. The result was
   * a card with nothing in it and a footer reading "This order keeps cooking"
   * for an order nobody was making.
   *
   * That is the bug behind every screenshot of this: first it rendered as
   * "RECEIVED" (`stepIndex` fell back to zero), then as an empty card once
   * that fallback was removed. Both were the same missing three statuses.
   *
   * A Set, and one derived from `OrderStatus` rather than a pair of `===`
   * comparisons, because the failure mode of the old form was silence: adding
   * a status server-side made the client render nothing at all, and nothing
   * anywhere said so.
   */
  const NOT_BEING_MADE = new Set([
    'REJECTED',
    'CANCELLED',
    'REFUND_PENDING',
    'REFUNDED',
    'REFUND_FAILED',
  ]);
  const rejected = NOT_BEING_MADE.has(o.status);

  /**
   * Rejected by the stall, or cancelled by somebody?
   *
   * The status alone stops answering this the moment it advances to
   * REFUND_PENDING — both paths converge there. `rejectionReason` is set only
   * on the reject path (the state machine marks `reject` as
   * `requiresReason: true`), so it survives the transition and is the honest
   * signal. Telling somebody the kitchen refused an order they cancelled
   * themselves is a different and worse sentence.
   */
  const wasCancelled = o.status === 'CANCELLED' || (!o.rejectionReason && rejected);
  /**
   * Paid, and no stall ever took it. §9 case D — the ladder ran out.
   *
   * TERMINAL. Distinct from `undispatched` below, which is the same shape of
   * problem while it is still recoverable: this one is over, offers a refund,
   * and will not fix itself; that one is a delay the worker is still retrying.
   * Two cards, because "we are still trying" and "we stopped trying" are
   * different things to tell somebody waiting for lunch.
   */
  const stalled = o.status === 'DISPATCH_FAILED';

  /**
   * The system cannot work out what happened to the money, and has stopped
   * guessing.
   *
   * `RECONCILIATION_REQUIRED` is the one order status that means a HUMAN has
   * to look. It is set when the provider's answer and our ledger disagree —
   * PRD §7.4's terminal "we do not know" — and it is the last of the
   * seventeen server statuses this screen had never named.
   *
   * It gets its own card rather than joining `stalled` or `rejected`, because
   * it is neither: nothing was refused and nothing is being retried. The only
   * honest thing to say is that somebody is looking, that the money is
   * accounted for, and that paying again would be the wrong move.
   */
  const needsHuman = o.status === 'RECONCILIATION_REQUIRED';

  /**
   * Placed, but never paid for.
   *
   * The step rail rendered this as "Order placed · we have your order", which
   * is reassurance the system has not earned: no kitchen will ever see this
   * order, because the board only shows PAYMENT_CONFIRMED onwards. A customer
   * reading that sits down and waits for food nobody is making.
   *
   * `PAYMENT_EXPIRED` is separated from the two live ones — nothing was
   * declined and nothing can be resumed, so the only honest action is to start
   * again rather than to keep offering a payment window that has closed.
   */
  /*
   * ==========================================================================
   * "NOT PAID" AND "ORDER NOT ADVANCED" ARE DIFFERENT THINGS
   * ==========================================================================
   *
   * This was the order status alone, and it told a customer whose money had
   * already left their account "Payment not completed", with a button inviting
   * them to pay a second time.
   *
   * Only a signed provider webhook moves an order into a financially
   * authoritative state (§7.4). The status poll updates the PAYMENT row and
   * deliberately leaves the order alone — so between capture and the webhook
   * arriving, `payment = CAPTURED` and `order = PAYMENT_PENDING` are both true
   * and both correct.
   *
   * `paymentSecured` comes from the payment row, so the screen can tell the two
   * apart: still unpaid, or paid and waiting on confirmation.
   */
  const unpaid = (o.status === 'CREATED' || o.status === 'PAYMENT_PENDING') && !o.paymentSecured;

  /** Money taken, order not yet advanced. Waiting on the webhook, not on the customer. */
  const confirming =
    (o.status === 'CREATED' || o.status === 'PAYMENT_PENDING') && o.paymentSecured;

  const awaitingPayment = unpaid;
  const paymentLapsed = o.status === 'PAYMENT_EXPIRED' || o.status === 'PAYMENT_FAILED';
  const ready = o.status === 'READY';
  const collected = o.status === 'COLLECTED';

  /**
   * ==========================================================================
   * PAID, AND THE STALL STILL HAS NOT BEEN TOLD
   * ==========================================================================
   *
   * `PAYMENT_CONFIRMED` means the money is ours and the order has not been
   * dispatched to a kitchen yet. That is a normal state for a second or two —
   * the worker sweeps and dispatches — and it is a serious one if it persists,
   * because the customer is sitting in a food court waiting for food nobody is
   * making.
   *
   * This warning used to live on the PAYMENT screen, where it held a paid
   * customer hostage refusing to confirm their payment. It belongs here: this
   * screen already watches the order continuously, so it can show the state
   * while it lasts and drop it the moment dispatch happens, instead of the pay
   * screen deciding once and being stuck with the answer.
   *
   * TWENTY SECONDS, not the pay screen's six. That number was chosen for a
   * screen a customer stares at during a handoff; here the order is already
   * placed, the worker ladder redispatches at 15 and 45 seconds, and shouting
   * before the first retry has even run would make a normal recovery look like
   * a fault.
   */
  const undispatched =
    o.status === 'PAYMENT_CONFIRMED' && Date.now() - new Date(o.placedAt).getTime() > 20_000;

  return (
    <div className="flex-1 flex flex-col bg-page">
      {/*
        THE ORDER NUMBER TAKES THE MAP'S PLACE, AND THAT IS THE WHOLE POINT.
        A delivery app puts a map here because the customer's question is "where
        is my food". In a food court the food does not move — the customer does,
        and their question is "what do I say at the counter". So the largest
        thing on the screen is the answer to that, and there is no map, no ETA
        and no arrival time, because all three would be inventing a journey that
        is not happening.

        Four banner tokens rather than four status colours: `bg-warn-500` here
        put white on #E5A50A — 2.16:1, the worst contrast in the app, on the one
        header asking the customer to go and do something.
      */}
      {/*
        SHORTER THAN IT WAS, BY ABOUT A THIRD.

        `pt-6 pb-7` around a 64px number made this band a third of a phone
        screen for two lines and a word. The number still has to be readable
        across a counter at arm's length — that is what it is FOR — but 44px is
        already twice the size of anything else on the page, and ending the band
        early puts the thing the customer has to act on above the fold instead
        of below it.
      */}
      <header
        className={`safe-top px-5 py-6 text-center text-on-banner ${
          ready
            ? 'bg-banner-ready'
            : rejected || o.status === 'PAYMENT_EXPIRED' || o.status === 'PAYMENT_FAILED'
              ? 'bg-banner-alert'
              : o.status === 'CREATED' || o.status === 'PAYMENT_PENDING'
                ? 'bg-banner-attention'
                : 'bg-banner-wait'
        }`}
      >
        {/*
          ============================================================
          THE RHYTHM, AND WHY IT IS EVEN
          ============================================================

          `pt-4 pb-5` with `mt-1` and `mt-1.5` between the three lines gave the
          band four different gaps and an unbalanced one at the bottom. The
          number is the hero; the two lines around it are its caption and its
          answer, and they are the same distance from it.

          One padding (`py-6`), one gap (`mt-2.5`). A band this simple has no
          reason to hold four numbers.

          ============================================================
          NO FADED TEXT, AND THAT IS A CONTRAST FIX
          ============================================================

          These were `opacity-90` and `opacity-95`. On `banner-wait` — the state
          an order sits in for most of its life — 90% white measures 4.21:1
          against the band, which is under AA for the 9px line it was applied
          to. `tests/design/contrast.mjs` cannot see it: it measures the TOKEN
          pair, `on-banner` on `banner-wait`, which passes at 4.88:1. The
          opacity is applied on top of a value that was already close to the
          floor.

          Hierarchy comes from size, weight and tracking instead. Fading text to
          rank it is spending legibility on something typography does for free.
        */}
        {/*
          ============================================================
          AN INSTRUCTION ONLY WHILE IT IS TRUE
          ============================================================

          This said "Show this at the counter" unconditionally, over the
          largest text on the screen. On a REJECTED order that made the loudest
          element on the page an instruction to go and collect food that will
          never be made — directly contradicting the card below it, which
          correctly explains the rejection and the refund.

          Everything else about rejection already worked: the poll notices
          within four seconds, the band turns `banner-alert`, the headline is
          suppressed, the progress rail is replaced by the refund card, and a
          toast fires that stays until dismissed. This one line was the whole
          gap, and it was the line a customer reads first.

          The same applies once the order is COLLECTED or the payment lapsed —
          the number stays useful as a reference for talking to staff, but it
          is no longer a thing to show. So the copy names what the number IS
          rather than telling anyone to do something with it.

          `TERMINAL` covers collected, rejected, cancelled, refunded and
          expired in one word, which is right: the question "is this order
          still going to be handed over" has exactly that answer.
        */}
        <p className="eyebrow text-[10px] tracking-[0.16em]">
          {TERMINAL.has(o.status) || awaitingPayment ? 'Order reference' : 'Show this at the counter'}
        </p>
        <p className="display text-[46px] sm:text-[54px] tnum leading-none tracking-tight mt-2.5">
          {o.orderNumber}
        </p>
        <p className="text-[13px] font-medium mt-2.5">{o.vendorName}</p>
      </header>

      {/*
        The headline the reference leads with, moved under the number.
        It answers "what is happening" in one line, which is the second question
        after "what do I say" — and unlike the reference's ETA, every one of
        these is a fact the system holds rather than a prediction.
      */}
      {/*
        `current !== null` joins the guard, and it is not redundant with the
        four flags beside it. Those cover the states this screen KNOWS are off
        the forward rail; `current === null` covers the ones it does not — a
        status added server-side after this build shipped. Without it the
        headline reads `STEPS[current]!.headline` on an index of `null`, which
        is `undefined.headline`: a white screen, not a wrong label.
      */}
      {current !== null && !awaitingPayment && !confirming && !paymentLapsed && !rejected ? (
        <div className="px-5 pt-5 text-center">
          {/*
            Both of these read straight out of STEPS now. They used to carry a
            `collected ? 'Collected' : …` special case, written when COLLECTED
            had no step of its own — the wording lived here and nowhere else.
            Now that it has one, keeping the branch would mean two places
            claiming to say what a collected order looks like, and they would
            drift the first time only one was edited. The step owns it.
          */}
          <h1 className="display text-[28px] text-ink-900">{STEPS[current]!.headline}</h1>
          <p className="text-[14px] text-ink-500 mt-1.5">
            {/* The one line that is computed rather than fixed: the item count
                is only worth saying while the food is being made. */}
            {current === 2
              ? `Kitchen is preparing ${o.items.length} ${o.items.length === 1 ? 'item' : 'items'}.`
              : STEPS[current]!.hint}
          </p>
        </div>
      ) : null}

      {/* `measure`: tracking one order is a sequence, not a set. Widening it
          would only stretch the progress rail across a desktop. */}
      <main className="measure flex-1 w-full px-4 md:px-6 py-5">
        {/*
          The old "Ready to collect" and "Collected" cards are GONE, not moved.
          The headline above now says both, and a card repeating it directly
          underneath was the same sentence twice — which reads as an interface
          that does not trust you to have read the first one.

          Nothing is lost: "show order N at the stall" was the card's content,
          and the number is now the largest thing on the screen with the stall
          named under it.
        */}
        {awaitingPayment ? (
          <Card className="p-5 mb-4 border-2 border-warn-500">
            <p className="text-[17px] font-bold text-ink-900">Payment not completed</p>
            <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
              This order has not been paid for, so the stall has not received it. Nothing has
              been charged.
            </p>
            <button
              onClick={() => navigate(`/pay/${o.orderId}`)}
              /* The same material as Place order and the cart island — see
                 `.glass-action`. A flat fill here and a lit one two screens
                 earlier is two vocabularies for one kind of button. */
              className="pressable glass-action mt-4 w-full rounded-xl text-on-brand font-bold text-[15px]
                         tracking-wide py-3.5"
            >
              COMPLETE PAYMENT
            </button>
          </Card>
        ) : null}

        {paymentLapsed ? (
          <Card className="p-5 mb-4 border-2 border-ink-200">
            <p className="text-[17px] font-bold text-ink-900">
              {o.status === 'PAYMENT_EXPIRED' ? 'The payment window closed' : 'The payment failed'}
            </p>
            <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
              Nothing was charged and the stall never received this order. Order again when you
              are ready.
            </p>
            <button
              onClick={() => navigate('/court')}
              /* The same material as Place order and the cart island — see
                 `.glass-action`. A flat fill here and a lit one two screens
                 earlier is two vocabularies for one kind of button. */
              className="pressable glass-action mt-4 w-full rounded-xl text-on-brand font-bold text-[15px]
                         tracking-wide py-3.5"
            >
              BACK TO THE STALLS
            </button>
          </Card>
        ) : null}

        {needsHuman ? (
          <Card className="p-5 mb-4 border-2 border-warn-500">
            <p className="text-[17px] font-bold text-ink-900">We are checking this order</p>
            <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
              Something about the payment did not add up, so we have stopped it here rather
              than guess. Somebody is looking at it now.{' '}
              <span className="font-semibold text-ink-700">Do not pay again.</span> Your money is
              accounted for either way — you will be charged correctly or refunded in full.
            </p>
            <p className="text-[12px] text-ink-400 mt-3 tnum">Order {o.orderNumber}</p>
          </Card>
        ) : null}

        {stalled ? (
          <Card className="p-5 mb-4 border-2 border-warn-500">
            <p className="text-[17px] font-bold text-ink-900">No stall has picked this up</p>
            {/*
              THE BUTTON THIS SCREEN HAS BEEN PROMISING.

              The escalation ladder sets `customer_offered_cancel_at` at its
              fourth rung and the copy here told the customer they could have
              their money back. There was no endpoint behind it — a paid order,
              no kitchen, and no way out, reachable in three minutes.
            */}
            <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
              We have tried the stall several times and they have not accepted. You can cancel
              and get your money back, or wait a little longer.
            </p>
            <button
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
              className="pressable glass-hover mt-4 w-full rounded-xl bg-brand-fill text-on-brand font-bold
                         text-[15px] tracking-wide py-3.5 disabled:opacity-50"
            >
              {cancel.isPending ? 'CANCELLING…' : 'CANCEL AND REFUND ME'}
            </button>
            {cancel.isError ? <ErrorState error={cancel.error} /> : null}
          </Card>
        ) : null}

        {confirming ? (
          <Card className="p-5 mb-4 border-2 border-warn-500">
            <p className="text-[17px] font-bold text-ink-900">Payment received</p>
            <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
              We are confirming it with the bank and passing your order to the stall. This
              usually takes a few seconds.{' '}
              <span className="font-semibold text-ink-700">Do not pay again.</span>
            </p>
            <p className="text-[12px] text-ink-400 mt-3 tnum">Order {o.orderNumber}</p>
          </Card>
        ) : null}

        {undispatched ? (
          <Card className="p-5 mb-4 border-2 border-warn-500">
            <p className="text-[17px] font-bold text-ink-900">
              We have your money and the stall has not been told yet
            </p>
            <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
              Your payment went through. The order has not reached the kitchen — we are still
              trying. <span className="font-semibold text-ink-700">Do not pay again.</span> If it
              cannot be delivered to the stall, you are refunded automatically.
            </p>
            <p className="text-[12px] text-ink-400 mt-3 tnum">Order {o.orderNumber}</p>
          </Card>
        ) : null}

        {rejected ? (
          <Card className="p-5 mb-4 border-2 border-alert-500">
            {/*
              ==============================================================
              THE RAIL STAYS WHEN THINGS GO WRONG
              ==============================================================

              A rejected order used to lose the rail entirely and get prose in
              its place. That removed the one element orienting the customer at
              the exact moment they most needed orienting — "where is my order
              and what happens next" is a more urgent question when the answer
              is bad, not a less relevant one.

              Received -> Rejected -> Refunded. The first node is a green tick
              because the order genuinely WAS received and nothing later undoes
              that; the second is a red cross rather than a tick, because it
              completed and it is not good news; the third moves on its own as
              the refund does, which is the part the customer is actually
              waiting on by then.

              Inside the alert card rather than above it, so the diagram and
              the sentence explaining it are one panel. Two cards saying
              related things about the same event is what this screen already
              had too much of.
            */}
            <div className="pb-5 mb-5 border-b border-ink-100">
              <Rail
                ariaLabel="Refund progress"
                /* `wasCancelled`, not the status: by REFUND_PENDING the two
                   paths have converged and only the reason distinguishes them. */
                steps={wasCancelled ? CANCELLED_STEPS : REJECTED_STEPS}
                /*
                 * The line runs the whole way regardless of the refund's
                 * stage. It marks the path TAKEN, and the money is already on
                 * that path the moment the order is rejected — PRD §14.7 makes
                 * the refund automatic, so there is no branch where it stops
                 * at node two. What the third NODE shows is whether it has
                 * landed; what the line shows is where this order went.
                 */
                fillTo={2}
                fillClass="bg-alert-500"
                toneAt={(i) => {
                  // Received. It happened, and it is not retracted.
                  if (i === 0) return 'done';
                  // Rejected or cancelled. Reached, and bad.
                  if (i === 1) return 'bad';

                  /*
                   * The refund, read from the live row rather than assumed.
                   *
                   * FAILED is `bad` and not `done`: a refund that could not be
                   * made automatically needs a human, and the card below says
                   * so. Showing a tick there would be the screen telling
                   * somebody their money is back when it is not — the single
                   * worst thing this rail could say.
                   *
                   * No refund row yet is `active`, not `pending`: the worker
                   * raises it within seconds of the rejection, so it is
                   * genuinely in progress rather than not started.
                   */
                  /*
                   * THE ORDER STATUS FIRST, the refund row second.
                   *
                   * `order.status` is moved by `transitionOrder` inside the
                   * transaction that did the work, so REFUNDED and
                   * REFUND_FAILED are the authoritative answers. The `refund`
                   * row is the detail behind them and can lag by a tick — and
                   * for a few seconds after a rejection it does not exist at
                   * all, which is why the fallback below is `active` and not
                   * `pending`.
                   */
                  if (o.status === 'REFUND_FAILED') return 'bad';
                  if (o.status === 'REFUNDED') return 'done';

                  if (!o.refund) return 'active';
                  if (o.refund.status === 'FAILED') return 'bad';
                  if (o.refund.settledAt || o.refund.status === 'SUCCEEDED') return 'done';
                  return 'active';
                }}
              />
            </div>

            <p className="text-[17px] font-bold text-ink-900">
              {wasCancelled ? 'This order was cancelled' : 'The kitchen could not make this'}
            </p>
            {/* Never blames the stall, and never leaves the money unexplained.
                ESC-02 and PRD §14.7 — the refund is automatic, so say so
                plainly rather than telling someone to contact support. */}
            <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
              You do not need to do anything — the refund is automatic.
            </p>

            {/*
              ==============================================================
              THE REFUND'S ACTUAL STAGE, NOT A REASSURING GENERALITY
              ==============================================================

              This used to say "your refund has already started" and stop. It is
              true and it is the wrong place to stop: the customer can see the
              money has left their account, and "started" describes a process
              they will watch a static screen about until it either arrives or
              they give up and go to the counter.

              The server now sends the live refund row, so this says which stage
              it is at. Three states, three different sentences:

                started but not settled  it is moving; here is the amount
                settled                  it is in your account
                failed                   a human has to fix it — say so, and
                                         do not pretend otherwise

              A rejected order with NO refund row yet is normal for a few
              seconds: the worker raises it. Saying nothing in that window is
              better than inventing a stage.
            */}
            {o.refund ? (
              <div className="mt-4 rounded-xl bg-ink-50 p-4">
                <p className="text-[13px] font-bold text-ink-900">
                  {o.refund.status === 'SUCCEEDED'
                    ? 'Refund credited'
                    : o.refund.status === 'FAILED'
                      ? 'Refund could not be completed'
                      : 'Refund in progress'}
                </p>
                <p className="text-[13px] text-ink-500 mt-1.5 leading-relaxed">
                  {o.refund.status === 'SUCCEEDED' ? (
                    <>
                      {formatINR(o.refund.amountPaise)} has been sent back to the way you paid.
                      Banks can take a little longer to show it.
                    </>
                  ) : o.refund.status === 'FAILED' ? (
                    <>
                      We could not return {formatINR(o.refund.amountPaise)} automatically. Show
                      this screen at the counter — the money is not lost.
                    </>
                  ) : (
                    <>
                      {formatINR(o.refund.amountPaise)} is on its way back to the way you paid.
                    </>
                  )}
                </p>
                {o.refund.settledAt ? (
                  <p className="text-[12px] text-ink-400 mt-2 tnum">
                    Completed {new Date(o.refund.settledAt).toLocaleTimeString()}
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>
        ) : awaitingPayment || paymentLapsed ? null : (
          <Card className="p-5 mb-4">
            {/*
              HORIZONTAL, and the rail is one element behind the dots.
              Individual segments between the points are fiddly to align and
              drift by a pixel at every breakpoint. One absolutely-positioned
              track with one fill over it stays exact at any width, and the
              dots sit on top with their own background so the line appears to
              pass behind them.

              `left-[10%] right-[10%]` is not a guess: five `w-1/5` columns put
              their centres at exactly 10, 30, 50, 70 and 90 percent, so the
              track begins and ends dead centre of the first and last dot. It
              was approximate with four columns (12.5% to 87.5% against the
              same 10/90 track) and the extra step happens to make it exact.
              Changing the number of steps again means revisiting these two
              numbers along with the fill's 80.
            */}
            {/*
              NOT RENDERED AT ALL for a status this rail cannot place.
              `stepIndex` returns null rather than falling back to zero, so an
              unknown status now shows no rail instead of confidently showing
              "RECEIVED" — see the note on `stepIndex`. The cards above and
              below still explain whatever is actually happening.
            */}
            {current === null ? null : (
            <Rail
              ariaLabel="Order progress"
              steps={STEPS.map((s) => s.label)}
              fillTo={current}
              fillClass="bg-banner-ready"
              toneAt={(i) => {
                /*
                 * `collected` is the whole journey finished, so the last node
                 * is a TICK rather than the red in-progress dot. Without this
                 * the rail reads "still waiting on you" under a headline that
                 * says the food is already in your hands.
                 *
                 * No `bad` tone here: a rejected order does not reach this
                 * rail at all — it gets the three-step one, above the refund
                 * card. Collection is the only ending THIS rail describes.
                 */
                if (i < current || collected) return 'done';
                if (i === current) return 'active';
                return 'pending';
              }}
            />
            )}

            {/*
              THE PROGRESS BAR IS GONE, AND THE REASSURANCE TOOK ITS PLACE.

              There was a filled bar under this rail on the argument that a
              glance reads the bar and a proper look reads the labels. In
              practice it was the same four states drawn twice, six pixels
              apart, in a second colour — the rail already fills its connectors
              green behind the tick, so the "glance" reading was covered.

              What goes here instead is the line that was stranded at the bottom
              of the page under a card it had nothing to do with. It belongs to
              the rail: it explains why the rail moves on its own.
            */}
            {!TERMINAL.has(o.status) && !awaitingPayment ? (
              <p className="text-[12px] text-ink-500 text-center mt-5 pt-4 border-t border-ink-100">
                This updates by itself. You can put your phone away.
              </p>
            ) : null}
          </Card>
        )}

        {/*
          COLLAPSED BY DEFAULT, as the reference has it.
          What somebody is doing on this screen is waiting, and while waiting
          the item list is the least useful thing on it — they chose those items
          two minutes ago. It matters at exactly one moment, at the counter,
          checking what arrived against what was ordered, and it is one tap away
          then. Everything above it is what changes while they wait.
        */}
        <Card>
          <button
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="pressable w-full px-4 py-4 flex items-center justify-between text-left"
          >
            <span className="min-w-0">
              <span className="block font-bold text-[15px] text-ink-900 truncate">
                {o.vendorName}
              </span>
              <span className="block text-[12px] text-ink-500 mt-0.5 tnum">
                Order {o.orderNumber} · {o.items.length}{' '}
                {o.items.length === 1 ? 'item' : 'items'} · {formatINR(o.totals.totalPayablePaise)}
              </span>
            </span>
            <svg
              viewBox="0 0 24 24"
              className={`size-5 text-ink-400 shrink-0 transition-transform ${
                showDetails ? 'rotate-180' : ''
              }`}
              fill="none"
              aria-hidden
            >
              <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {showDetails ? (
            <div className="border-t border-ink-100 divide-y divide-ink-100">
              {o.items.map((i) => (
                <div key={i.name} className="px-4 py-3 flex justify-between items-baseline text-[14px]">
                  <span className="text-ink-700">
                    <span className="font-semibold tnum">{i.quantity}</span> × {i.name}
                  </span>
                  <span className="tnum font-semibold text-ink-900">
                    {formatINR(i.lineTotalPaise)}
                  </span>
                </div>
              ))}
              <div className="px-4 py-3 flex justify-between items-baseline">
                <span className="font-bold text-ink-900 text-[15px]">Paid</span>
                <span className="tnum font-bold text-ink-900 text-[16px]">
                  {formatINR(o.totals.totalPayablePaise)}
                </span>
              </div>
            </div>
          ) : null}
        </Card>

      </main>

      {/*
        THE WAY OUT.
        Without this the tracking screen is a cul-de-sac: no back chevron, no
        nav, nothing. A customer with a curry cooking at one stall could not
        reach a second stall for a drink — which is the entire premise of a
        food court, refused by a missing button.
        Always available, including once collected, because the most likely
        moment somebody wants a second thing is right after the first arrives.
      */}
      <BottomBar>
        {/*
          TWO exits, because "order more" has two meanings and only one of them
          was reachable.

          More from THIS stall is a second order at the same kitchen — no
          special case, just a fresh cart at the same vendor. It was always
          possible (`vendorId` survives checkout) and there was simply no button
          for it, so the only route back was via the stall list, under a label
          that said "another stall".
        */}
        <div className="flex gap-2.5">
          <button
            onClick={() => {
              // Re-point the cart at this stall before navigating. Without it a
              // customer who has since browsed elsewhere lands on the right
              // menu with the wrong vendor in the cart, and checkout would
              // price against a stall they are not looking at.
              setVendor(o.vendorId, o.vendorName);
              navigate(`/vendor/${o.vendorId}`);
            }}
            className="pressable glass-action flex-1 rounded-xl text-on-brand font-bold text-[14px]
                       tracking-wide py-3.5"
          >
            ADD MORE
          </button>
          <button
            onClick={() => navigate('/court')}
            /*
              GLASS, BUT NOT THE ACTION GLASS.

              `glass-action` carries the brand fill and the lit rim — it says
              "this is the one to press". This is the alternative beside it, so
              it takes the frosted plate instead: same material family, none of
              the weight. Two buttons with identical treatment side by side is a
              choice with no recommendation in it.
            */
            className="pressable glass-on flex-1 rounded-xl border border-brand-200
                       text-brand-700 font-bold text-[14px] tracking-wide py-3.5"
          >
            OTHER STALLS
          </button>
        </div>
        <p className="text-[11px] text-ink-400 text-center mt-2 pb-1">
          {/* "Keeps cooking" is false for an order nobody is making. The card
              above owns the explanation and the refund; this line only has to
              stop contradicting it. */}
          {collected
            ? `Order again from ${o.vendorName}, or try somewhere else.`
            : rejected
              ? 'Nothing is being made. Find this order under Your orders.'
              : 'This order keeps cooking. Find it again under Your orders.'}
        </p>
      </BottomBar>
    </div>
  );
}
