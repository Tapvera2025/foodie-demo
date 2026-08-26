import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';
import { cashfreeSession, startCheckout, CashfreeLoadError } from '../lib/cashfree';
import { formatINR } from '../lib/money';
import { useCart } from '../lib/cart';
import { Card, ErrorState, FoodTile, Screen, Spinner } from './ui';

/** Payment states that will not change again without a human. */
const SETTLED = ['AUTHORIZED', 'CAPTURED', 'FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED'];

/**
 * The payment step.
 *
 * WHAT THIS SCREEN DELIBERATELY CANNOT DO
 *
 * It cannot confirm a payment. Nothing it sends will move the order forward —
 * the only channel that can is the provider's signed webhook (PRD §7.4). So
 * this screen creates an intent, hands off, and then asks the SERVER what
 * happened, repeatedly, until the server has heard from the provider.
 *
 * The success state below is therefore a REPORT, not a claim. It renders when
 * the server says the money is blocked or taken, which it only knows from a
 * verified provider event. There is still no "I have paid" button, because a
 * browser saying so is a hint and a button that looked authoritative would be
 * lying to the person pressing it.
 */
export function Pay() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();

  /**
   * Did the customer get here by tapping "Pay Now & Place Order" a second ago?
   *
   * Set by Checkout on that one navigation and nowhere else. It decides whether
   * this screen opens the payment sheet by itself or waits to be asked, and
   * getting that distinction right is the whole point:
   *
   *   just tapped pay  -> open the sheet; a button here would be the second
   *                       "pay" tap for one decision
   *   any other way    -> show the button. Reload, back-navigation, a shared
   *                       link, or returning to an order abandoned unpaid —
   *                       in every one of those a sheet opening on its own is
   *                       something the customer did not ask for.
   *
   * Router state, so it dies on reload. That is the correct lifetime for a
   * fact about how this render was reached.
   */
  const autoStart = Boolean((useLocation().state as { autoStart?: boolean } | null)?.autoStart);
  const [handedOff, setHandedOff] = useState(false);

  /**
   * The court name, from the cart.
   *
   * `OrderView` carries the stall but not the venue, and the customer is
   * standing in the venue — "Tandoor Tales, Phoenix Marketcity Level 3" is what
   * tells them where to walk. It survives a reload because the cart is
   * persisted; if it somehow does not, the stall name alone is still correct
   * and the line just gets shorter.
   */
  const foodCourtName = useCart((s) => s.foodCourtName);

  const intent = useQuery({
    queryKey: ['intent', orderId],
    queryFn: () => api.paymentIntent(orderId!),
    enabled: Boolean(orderId),
    // Safe to repeat: the server returns the existing live intent rather than
    // opening a second one (PAY-REC-03). Still, once is enough.
    staleTime: Infinity,
    retry: false,
  });

  /**
   * Polls the server, which asks the provider.
   *
   * PRD §9 case A: the customer can pay and close the browser before coming
   * back. The webhook confirms regardless, and this loop notices. Case B is
   * the same loop from the other direction — the client thinking it failed
   * changes nothing about what the provider says.
   */
  const status = useQuery({
    queryKey: ['payment-status', orderId],
    queryFn: () => api.paymentStatus(orderId!),
    enabled: Boolean(orderId) && intent.isSuccess,
    refetchInterval: (q) => {
      const s = (q.state.data as { paymentStatus: string | null } | undefined)?.paymentStatus;
      // Stop on any settled state, not just the happy ones. Polling a payment
      // that has already reached RECONCILIATION_REQUIRED asks the provider the
      // same question every 1.2 seconds for as long as the tab is open, and no
      // answer it can give will change the row.
      return s !== null && s !== undefined && SETTLED.includes(s) ? false : 1200;
    },
  });

  const settled = status.data?.paymentStatus;

  /**
   * The ORDER, polled alongside the payment — not gated behind it.
   *
   * It used to be `enabled: paid`, which made the two mutually dependent: the
   * screen decided it was paid from the payment alone, then fetched the order
   * only to print a number on the receipt. The order was never consulted about
   * whether the payment had actually landed.
   *
   * Polling it here is what lets `paid` below mean "the platform acted", and
   * the interval stops as soon as it has.
   */
  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.order(orderId!),
    enabled: Boolean(orderId),
    refetchInterval: (q) => {
      const s = (q.state.data as { status: string } | undefined)?.status;
      return s === undefined || s === 'CREATED' || s === 'PAYMENT_PENDING' ? 1200 : false;
    },
  });

  /**
   * THE PAYMENT BEING AUTHORISED IS NOT THE SAME AS THE ORDER BEING PLACED.
   *
   * This screen used to declare success on `paymentStatus` alone, and that read
   * is not what it looks like. `GET /payment` calls `refreshFromProvider`, which
   * asks the PROVIDER and — deliberately — writes only the payment row, leaving
   * the order to the signed webhook. So the value here is the provider's
   * opinion about money, not the platform's opinion about the order.
   *
   * When the webhook transaction failed, those two diverged and produced the
   * worst screen in the product: a green "Payment successful", then a tracking
   * page saying "Payment not completed", and no ticket at the stall. The
   * customer was told the one thing they most need to be able to trust, and it
   * was wrong.
   *
   * Success now requires BOTH. The payment says money is secured; the order
   * status says the platform acted on it. Anything else is still in flight,
   * which is what the waiting state is for.
   */
  const paymentSecured = settled === 'AUTHORIZED' || settled === 'CAPTURED';
  const orderMoved =
    order.data !== undefined &&
    order.data.status !== 'CREATED' &&
    order.data.status !== 'PAYMENT_PENDING';

  /*
   * ==========================================================================
   * SUCCESS IS ABOUT THE PAYMENT. THE ORDER'S FATE BELONGS TO TRACKING.
   * ==========================================================================
   *
   * This was `paymentSecured && orderMoved` — the screen refused to confirm a
   * payment until a kitchen had been told about the order. The instinct behind
   * it was right and the conclusion was wrong.
   *
   * They are two different facts. The money HAS moved: the customer's bank has
   * told them so, and a screen that will not admit it reads as a system that
   * lost their ₹210. Whether the stall has been told is the ORDER's status, it
   * changes several more times after this, and there is a whole screen whose
   * job is to show exactly that — including rejection, refund started, and
   * refund credited.
   *
   * So the pay screen confirms the payment and hands over. Anything that
   * happens to the order afterwards is the tracking screen's to narrate, which
   * it can do continuously instead of this screen guessing once.
   */
  const paid = paymentSecured;
  const failed = settled === 'FAILED' || settled === 'EXPIRED';

  /**
   * Money taken, order not advanced. The state that must never be silent.
   *
   * The customer has paid and no kitchen has been told. Nothing the client can
   * do fixes it — the webhook is the only channel that advances an order — so
   * this says so plainly rather than spinning, and does it after a short grace
   * period because the normal case resolves in under a second.
   */
  const orphaned = paymentSecured && !orderMoved;

  /**
   * A STATUS THAT IS NEITHER PAID NOR FAILED IS NOT A REASON TO KEEP SPINNING.
   *
   * `paid` and `failed` between them cover four of the nine payment states.
   * Everything else — RECONCILIATION_REQUIRED above all — used to fall through
   * to the waiting branch and render "Confirming your payment…" for ever. The
   * customer was told to wait for something that was never going to arrive, and
   * the screen had no way to say otherwise.
   *
   * PRD §2.2: a check whose failure mode is silence. An unrecognised outcome is
   * still an outcome, and the honest thing is to name it and hand to a human.
   */
  const stuck =
    settled != null &&
    !paymentSecured &&
    !failed &&
    settled !== 'PENDING' &&
    settled !== 'CREATED';

  /**
   * Development only, and it does NOT pretend to be the customer.
   *
   * It asks the server to forge a webhook from the stub provider and process it
   * through the real ingestion path — signature check included. So the flow
   * being exercised here is the production flow, which is the whole point of
   * having a shortcut at all.
   *
   * Fired automatically rather than from a button. With no aggregator there is
   * nothing for a customer to do on this screen, and a button that must be
   * pressed before anything happens teaches the wrong shape: in production the
   * customer leaves for a UPI app and the confirmation arrives on its own.
   */
  const simulate = useMutation({
    mutationFn: () => api.simulatePayment(orderId!),
    onSuccess: () => void status.refetch(),
  });

  /**
   * NO TIMER HERE, AND THAT IS THE WHOLE POINT.
   *
   * The first version scheduled `simulate.mutate()` on a 900ms `setTimeout` and
   * cleared it in the effect cleanup. Under StrictMode — which is on in
   * development, deliberately — React double-invokes effects:
   *
   * 1. effect runs → ref set to true, timer scheduled
   * 2. cleanup runs → clearTimeout, the mutation is cancelled
   * 3. effect re-runs → ref is already true, returns early, nothing rescheduled
   *
   * The mutation never fired and the screen span for ever. `simulate` being in
   * the dependency array made it worse: `useMutation` returns a new object when
   * its state changes, so the effect re-ran and cancelled the timer again.
   *
   * The shape to avoid: **a ref guard that survives a cleanup which cancels the
   * work the guard is protecting.** The guard then remembers doing something
   * that got undone. Firing synchronously has no such window, and the ref makes
   * the double-invoke idempotent instead of destructive.
   *
   * The 900ms "let them read the amount" beat is gone with it. Not much lost —
   * the receipt holds for 2.2 seconds and that is where the amount is worth
   * reading.
   */
  /**
   * THE AUTO-FIRE IS GONE. A BUTTON REPLACED IT, AND THAT IS THE PRODUCTION SHAPE.
   *
   * The previous version fired the stub webhook the instant the intent existed,
   * with a long note arguing that a button "teaches the wrong shape, because in
   * production the customer leaves for a UPI app and the confirmation arrives
   * on its own".
   *
   * Half right. The CONFIRMATION does arrive on its own — that is the webhook,
   * and it still is. But the HANDOFF is a deliberate act: the customer taps pay,
   * the aggregator's sheet opens, they choose UPI or a card there. A screen with
   * no button models a payment that happens without anyone agreeing to it, which
   * is the one part of this flow nobody would ship.
   *
   * So the button is the handoff and the webhook is still the authority. In
   * development it forges a stub event through the real ingestion path; in
   * production it will open the aggregator. Neither confirms anything.
   *
   * The `fired` ref stays: it makes a double-tap idempotent without a disabled
   * state that flickers.
   */
  const fired = useRef(false);

  /**
   * STATE as well as the ref, and they do different jobs.
   *
   * The ref makes a double-tap idempotent. The STATE is what the render reads —
   * a ref mutation does not schedule a render, and React explicitly warns
   * against reading one during render, so a screen whose branch depended on
   * `fired.current` would be correct only by the accident of some other state
   * changing at the same moment.
   */
  const [handoffStartedAt, setHandoffStartedAt] = useState<number | null>(null);

  /** Production build with no aggregator wired. See `payNow`. */
  const [noProvider, setNoProvider] = useState(false);

  /**
   * The handoff itself broke — the SDK would not load, or refused the session.
   *
   * Separate from `failed`, which means the PAYMENT failed. A customer whose
   * network dropped the payment library has not been declined by anyone and
   * must not be told they were; they need to try again, not to use another
   * card.
   */
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const payNow = (): void => {
    if (fired.current || paymentSecured || failed) return;
    fired.current = true;
    setHandoffError(null);
    setHandoffStartedAt(Date.now());

    /*
     * ======================================================================
     * THE REAL AGGREGATOR, WHEN THE SERVER HAS GIVEN US A SESSION
     * ======================================================================
     *
     * Checked BEFORE the DEV branch, deliberately. A developer who has wired
     * sandbox Cashfree credentials wants to exercise the real handoff — that is
     * the entire reason they configured it. Putting `import.meta.env.DEV` first
     * would mean the one person trying to test the integration is the only
     * person who never sees it.
     */
    const session = cashfreeSession(intent.data?.checkoutPayload);

    if (session) {
      void startCheckout(session)
        .then((r) => {
          if (r.outcome === 'FAILED') {
            setHandoffError(r.message);
            fired.current = false;
            setHandoffStartedAt(null);
            return;
          }
          /*
           * The customer came back and we know nothing. On purpose.
           *
           * `handoffStartedAt` STAYS SET, so the screen keeps showing "checking
           * with the bank" and the status poll keeps running. The SDK's own
           * opinion is not recorded anywhere, because the server is the only
           * thing that can be believed about money — PRD §9 case B.
           *
           * But `fired.current` is RELEASED, and that is not the same decision.
           *
           * The latch exists to stop a double-tap opening two checkouts while
           * one is on screen. Once the customer is back, there is no checkout
           * on screen and the most likely reason they returned is that they
           * closed it — a changed mind, a wrong UPI app, a mistake. Holding the
           * latch shut past that point is what strands them: the Pay button is
           * gone, the poll waits for a payment nobody made, and the only offer
           * on screen is "check again" for something that will never change.
           */
          fired.current = false;
        })
        .catch((e: unknown) => {
          setHandoffError(
            e instanceof CashfreeLoadError
              ? e.message
              : 'The payment screen could not be opened.',
          );
          fired.current = false;
          setHandoffStartedAt(null);
        });
      return;
    }

    if (import.meta.env.DEV) {
      simulate.mutate();
      return;
    }

    // No aggregator is wired. Refusing loudly is better than a button that
    // looks like it worked — PRD §19 row 2 is still open.
    //
    // Rendered into the page rather than thrown at a `window.alert`. An alert
    // was wrong twice over: it is OS chrome on a customer's phone, and it is a
    // DIALOG for something that is not a decision. There is nothing here to
    // agree to — it is a report, and it belongs in the same panel as every
    // other payment outcome this screen already knows how to show.
    setNoProvider(true);
    fired.current = false;
    setHandoffStartedAt(null);
  };

  /**
   * ==========================================================================
   * OPEN THE SHEET ON ARRIVAL, WHEN ARRIVING MEANT "PAY"
   * ==========================================================================
   *
   * The tap happened on the previous screen. This runs the handoff that tap
   * asked for, so the customer goes from one button straight to their bank's
   * sheet instead of through a screen that restates what they just approved.
   *
   * WAITS FOR THE INTENT. `payNow` reads `intent.data?.checkoutPayload` to
   * build the session, and a null payload takes the "no aggregator is wired"
   * branch and shows a refusal. Firing before the query resolves would
   * therefore not just be early — it would be WRONG, reporting a missing
   * provider for one that is merely still loading. `intent.data` in the
   * dependencies is what makes this wait.
   *
   * `fired.current` is the guard against running twice, and it is already the
   * guard `payNow` uses for a double tap — a re-render or a StrictMode
   * double-invoke reaches the same latch a fast second tap would. No separate
   * "has auto-started" flag, because two latches for one question drift.
   *
   * DELIBERATELY NOT RE-ARMED. If the customer dismisses the sheet, `payNow`
   * releases the latch so they can try again — but this effect does not fire
   * again, because its dependencies have not changed. They get the button.
   * Reopening a sheet somebody just closed would be the app arguing with them.
   */
  useEffect(() => {
    if (!autoStart || !intent.data || paymentSecured || failed) return;
    payNow();
    // `payNow` is recreated every render and is guarded by `fired.current`;
    // listing it would re-run this on every render for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, intent.data, paymentSecured, failed]);

  /**
   * A spinner with no end is not a state, it is an absence of one.
   *
   * Ten seconds without an outcome and the customer gets told, plus something
   * to press. This is not development scaffolding — it belongs in production
   * for exactly PRD §9 case B: the client cannot know what happened, and the
   * remedy is to ask the server again rather than to keep waiting silently.
   *
   * Safe to clean up, unlike the effect above: this only sets state, so a
   * StrictMode double-invoke reschedules it rather than destroying anything.
   */
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (paid || failed) return;
    /*
     * Starts at the HANDOFF, not at mount.
     *
     * It used to start when the screen appeared, which was harmless while the
     * webhook auto-fired and is a bug now that a human presses the button: sit
     * on the summary for eleven seconds reading it, tap Pay, and the very next
     * frame says "this is taking longer than usual" about a request that has
     * not been made yet.
     */
    if (handoffStartedAt === null) return;
    /*
     * Six seconds once the money is secured, ten while it is not.
     *
     * They are different questions. Waiting for a provider is normal and can
     * legitimately take ten seconds. Waiting for our OWN webhook transaction,
     * on money we already hold, is a round trip and a database write — if that
     * has not landed in six seconds it is not slow, it is wrong, and the
     * customer is currently being shown a screen implying their food is coming.
     */
    const t = setTimeout(() => setSlow(true), orphaned ? 6_000 : 10_000);
    return () => clearTimeout(t);
  }, [paid, failed, orphaned, handoffStartedAt]);

  /**
   * Hold the receipt on screen before moving on.
   *
   * Long enough to read the order number, short enough not to be a wall. The
   * customer can also tap through immediately — waiting is never mandatory.
   */
  useEffect(() => {
    if (!paid) return;
    const t = setTimeout(() => setHandedOff(true), 2200);
    return () => clearTimeout(t);
  }, [paid]);

  useEffect(() => {
    if (handedOff) navigate(`/order/${orderId}`, { replace: true });
  }, [handedOff, orderId, navigate]);

  /**
   * Confirm, then move on by itself.
   *
   * The tick is worth seeing — it is the answer to "did my money go?" — but it
   * is not worth waiting on, and a customer who has just paid should not have
   * to press a button to find out what happens next. 1.4 seconds is long enough
   * to read four words and short enough that nobody taps first.
   *
   * `replace`, via the same `handedOff` path as the button, so Back from the
   * tracking screen does not return to a payment that is already complete.
   */
  useEffect(() => {
    if (!paid || handedOff) return;
    const t = setTimeout(() => setHandedOff(true), 1400);
    return () => clearTimeout(t);
  }, [paid, handedOff]);

  if (intent.isLoading) {
    return (
      <Screen title="Payment">
        <Spinner label="Setting up your payment…" />
      </Screen>
    );
  }
  if (intent.isError || !intent.data) {
    return <ErrorState error={intent.error} onRetry={() => void intent.refetch()} />;
  }

  /*
   * The "money taken, stall not told" screen used to live here and has moved to
   * the TRACKING screen.
   *
   * It was reached from `orphaned && slow`, which held a paid customer on the
   * payment screen refusing to confirm their payment. The state it describes is
   * real and still surfaced — but it is a fact about the ORDER, it can resolve
   * on its own seconds later, and the screen that watches an order continuously
   * is the one that should say it.
   */

  if (paid) {
    return (
      <div className="flex-1 flex flex-col bg-success-page">
        <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <div className="size-20 rounded-full bg-surface grid place-items-center mb-6">
            <svg viewBox="0 0 24 24" className="size-11 text-fresh-700" fill="none" aria-hidden>
              <path
                d="M4 12.5l5.5 5.5L20 7"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <h1 className="text-[30px] font-black text-white leading-tight">Payment successful</h1>
          <p className="text-[17px] font-semibold text-white/90 tnum mt-1">
            {formatINR(intent.data.amountPaise)} paid
          </p>

          {order.data ? (
            <div className="mt-8 w-full max-w-xs rounded-card bg-surface px-6 py-5">
              <p className="text-[11px] font-bold uppercase tracking-widest text-ink-400">
                Your order number
              </p>
              <p className="text-[44px] leading-none font-black text-ink-900 tnum mt-1.5 tracking-tight">
                {order.data.orderNumber}
              </p>
              <p className="text-[13px] text-ink-500 mt-3 leading-relaxed">
                Sent to <span className="font-semibold text-ink-700">{order.data.vendorName}</span>.
                They will start preparing it now.
              </p>
            </div>
          ) : (
            <div className="mt-8 h-[152px] w-full max-w-xs rounded-card skeleton" />
          )}
        </main>

        <div className="measure w-full px-6 pb-8 safe-bottom">
          <button
            onClick={() => setHandedOff(true)}
            className="pressable glass-on w-full rounded-xl text-fresh-700 font-bold text-[15px]
                       tracking-wide py-4"
          >
            TRACK MY ORDER
          </button>
        </div>
      </div>
    );
  }

  /**
   * ------------------------------------------------------------ before paying
   *
   * The reference's screen: where you collect, what you ordered, what it costs,
   * one button.
   *
   * Shown only until the handoff. Once `simulate` or the aggregator has been
   * invoked the screen becomes the waiting states below, because at that point
   * the summary is no longer the useful thing on screen — the outcome is.
   */
  /*
   * ==========================================================================
   * TWO EXCLUSIONS, ONE OF WHICH IS A BUG THAT WAS ALREADY HERE
   * ==========================================================================
   *
   * `handoffError` / `noProvider` — THE FIX.
   *
   * Both failure paths in `payNow` set their message and then reset
   * `handoffStartedAt` to null, which made this true again and returned the
   * summary below. The panels that render those messages live after this
   * check, so they were UNREACHABLE: "The payment screen did not open", its
   * explanation and its Try again button have never once been shown. What the
   * customer actually got was the pay button back with no word about why the
   * last tap did nothing.
   *
   * That was a missing sentence when a human had to press pay. It becomes a
   * silent loop now that arrival can start the handoff on its own — fail,
   * re-render, look identical, offer nothing. So it is fixed here rather than
   * worked around.
   *
   * `autoStart` — THE POINT OF THE CHANGE.
   *
   * The effect that opens the sheet runs after the first paint, so without
   * this the screen being skipped would flash up for a frame on its way past.
   *
   * Excluding it is only safe BECAUSE of the fix above: every way the handoff
   * can end now leaves this screen somewhere real. It failed to open -> the
   * panel with Try again. The customer dismissed the sheet ->
   * `handoffStartedAt` stays set by design, so this is false anyway and they
   * get the waiting card with "Open the payment screen again". No provider ->
   * that panel. Nothing falls through to a blank screen, which is what would
   * have happened had `autoStart` been added on its own.
   */
  const awaitingHandoff =
    handoffStartedAt === null &&
    !paymentSecured &&
    !failed &&
    !handoffError &&
    !noProvider &&
    !autoStart;

  if (awaitingHandoff && order.data) {
    const o = order.data;
    const charges =
      o.totals.foodTaxPaise + o.totals.customerFeePaise + o.totals.customerFeeTaxPaise;

    return (
      /*
        `min-h-dvh`, and it is what makes the dock below a dock.

        The `flex-1` here is inherited from the shape every other screen uses,
        where it is inert: `#root` carries `min-height: 100dvh` but not
        `display: flex`, so there is no flex parent for it to grow inside. That
        does not matter on screens whose content fills the page — it does here,
        because a flex child cannot expand into a parent with no definite
        height, so the content div's `flex-1` would resolve to its own content
        and the button would land wherever the cards happened to end. Which is
        what the screenshot showed: a button floating mid-screen above a void.

        `dvh` rather than `vh` for the reason index.css gives at `#root` — iOS
        Safari's collapsing toolbar makes `100vh` taller than what you can see,
        and this is the exact button that note is about.

        This branch renders no app bar, so the viewport is entirely its own and
        there is no header height to subtract.
      */
      <div className="min-h-dvh flex-1 flex flex-col bg-page">
        <div className="flex-1 w-full px-5 pt-5 pb-4 space-y-4">
          {/*
            WHERE, not which table.
            The reference says "Dining At · Table 24", which assumes table
            service. A food court has shared seating that gets rearranged all
            day and nobody carries food to it — §2.1 is why there is no table
            concept in this system at all. The useful fact at this moment is
            where to WALK, so it is the stall and the venue.

            No Edit link either: by this point the order is written and priced.
            Changing it means a new order, and a link implying otherwise would
            be an offer the system cannot honour.
          */}
          <Card className="p-5">
            <h2 className="font-bold text-[15px] text-ink-900 mb-3">Collecting from</h2>
            <div className="flex items-center gap-3.5 rounded-xl bg-ink-50 p-3.5">
              {/*
                A BRAND-TINTED DISC, NOT A BLACK ONE.

                `bg-ink-900` made this the darkest object on the screen, which
                put the heaviest thing in the layout on the least important
                one — the stall's identity is already stated in bold beside it,
                and the icon is decoration.

                `bg-brand-50` with a `brand-700` glyph is the same disc the
                account row uses in Orders.tsx. Reusing that pairing rather
                than inventing one keeps the two circles in this app looking
                related, and it is a pairing the contrast suite already covers.
              */}
              <span
                aria-hidden
                className="size-11 shrink-0 grid place-items-center overflow-hidden
                           rounded-full bg-brand-50 text-brand-700"
              >
                {/*
                  The stall's own cover when it has one, the icon when it does
                  not. `vendor.cover_image_url` has existed since migration 12
                  and this screen was drawing a generic awning over the top of
                  it — the customer is being told where to walk, and the stall's
                  own frontage is the most useful thing to put on that.

                  `alt=""` with `aria-hidden` on the wrapper: the stall's name
                  is in bold immediately to the right, so announcing the photo
                  would repeat it. `object-cover` because a cover photo is
                  landscape and this frame is a circle — letterboxing it inside
                  the disc would look like a mistake.
                */}
                {o.vendorImageUrl ? (
                  <img
                    src={o.vendorImageUrl}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover"
                  />
                ) : (
                  <svg viewBox="0 0 24 24" className="size-5" fill="none">
                    <path
                      d="M4 10h16M6 10V7a2 2 0 012-2h8a2 2 0 012 2v3M7 10v9M17 10v9"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              {/* `flex-1`, not just `min-w-0`. Without it the text block sizes
                  to its content and the row's spare width goes nowhere — the
                  two lines truncate earlier than they need to on a narrow
                  phone, which is the other half of why this row looked wrong. */}
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-[15px] text-ink-900 truncate">
                  {o.vendorName}
                </span>
                <span className="block text-[13px] text-ink-500 truncate">
                  {foodCourtName ?? 'Show your order number at the counter'}
                </span>
              </span>
            </div>
          </Card>

          {/* ------------------------------------------------ order summary */}
          {/*
            OPEN ON ARRIVAL, AND ONE CARD RATHER THAN TWO.

            This was collapsed, on the argument that checkout had just shown
            the same bill and two identical summaries in a row make a customer
            wonder which one is real. That reasoning holds for the repetition
            and not for the hiding: this is the last screen before money moves,
            and the itemisation is the thing being consented to. A disclosure
            that has to be opened to see what you are paying for asks the
            customer to take one extra action to check the only fact that
            matters here. It stays a `<details>` so it can still be folded away
            by someone who has read it.

            THE SEAM. Closed, the header bar and a `mt-2` card below it read as
            one control. Open — which is now always, on arrival — the 8px gap
            between them was a visible break through the middle of what is
            plainly one panel. So the `<details>` IS the card: the surface,
            shadow and radius live on it, the body is inside it, and a rule
            separates the header from the items instead of a gap.

            `overflow-hidden` is load-bearing, not tidiness — it clips the
            summary row's hover film to the card's rounded corners. Without it
            the film paints a square over them on hover.

            `rounded-none` on the summary is the convention the shape check
            documents, and this went in without it and was caught: a
            `glass-hover` element must state a radius, because a film is the
            one thing that INVENTS a shape. Here the honest radius is none —
            the parent cuts these corners, and it cuts them correctly in both
            states. Open, the summary needs a rounded top and square bottom;
            closed, it is the whole card and needs all four. Naming either one
            on the element would be wrong half the time.
          */}
          <details open className="group bg-surface shadow-card rounded-card overflow-hidden">
            <summary
              className="pressable glass-hover rounded-none list-none cursor-pointer
                         px-5 py-4 flex items-center justify-between"
            >
              <h2 className="font-bold text-[15px] text-ink-900">Order summary</h2>
              <svg
                viewBox="0 0 24 24"
                className="size-5 text-ink-500 transition-transform group-open:rotate-180"
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
            </summary>
            <div className="px-5 pb-5">
            <hr className="border-ink-100 mb-4" />

            <ul className="space-y-3.5">
              {o.items.map((it) => (
                <li key={it.name} className="flex items-center gap-3.5">
                  {/*
                    THE PHOTOGRAPH, WHEN THERE IS ONE.

                    This drew the gradient unconditionally, on the reasoning
                    that `order_item` snapshots the name and price and not the
                    image, so a vendor swapping a photo cannot alter a past
                    order's receipt. The snapshot rule is right and it is about
                    the RECEIPT — it was being applied to the thumbnail as
                    well, which nothing requires.

                    The effect was that a customer chose a dish from a photo,
                    saw that photo in their basket, and then found a coloured
                    square on the one screen that asks for money. The order API
                    now joins `menu_item.image_url` live, so the picture
                    survives the whole journey.

                    `imageUrl` is null for an external item, a deleted dish, or
                    one with no photo, and FoodTile falls back to the same
                    deterministic gradient it drew before — which still matches
                    the tile on the menu, because it is hashed from the name.
                  */}
                  <FoodTile name={it.name} imageUrl={it.imageUrl} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-[14px] text-ink-900 leading-snug">
                      {it.name}
                    </span>
                    <span className="block text-[12px] text-ink-500 tnum mt-0.5">
                      ×{it.quantity}
                    </span>
                  </span>
                  <span className="font-bold text-[14px] text-ink-900 tnum shrink-0">
                    {formatINR(it.lineTotalPaise)}
                  </span>
                </li>
              ))}
            </ul>

            <hr className="border-ink-100 my-4" />

            <div className="flex justify-between items-baseline py-1 text-[13px] text-ink-500">
              <span>Subtotal</span>
              <span className="tnum">{formatINR(o.totals.subtotalPaise)}</span>
            </div>
            <div className="flex justify-between items-baseline py-1 text-[13px] text-ink-500">
              <span>Taxes and charges</span>
              <span className="tnum">{formatINR(charges)}</span>
            </div>

            <hr className="border-ink-100 my-3" />

            <div className="flex justify-between items-baseline">
              <span className="font-bold text-[15px] text-ink-900">Total</span>
              <span className="display text-[28px] text-ink-900 tnum">
                {formatINR(o.totals.totalPayablePaise)}
              </span>
            </div>
            </div>
          </details>

          {/*
            No payment-method list, and that is a decision rather than a gap.
            An aggregator renders its own sheet — UPI, card, netbanking — so a
            list here would make the customer choose twice and the second choice
            would be the one that counted. This button is the handoff; the
            method is picked on the other side of it.
          */}
          </div>

          {/*
            DOCKED, BECAUSE THE SUMMARY ABOVE IT NOW OPENS.

            This button used to sit in the flow, last in the column. That was
            survivable while the summary was folded and the page was three
            short cards; with the itemisation expanded a six-item order pushes
            the only action on the screen below the fold, and the customer's
            next move becomes "scroll" rather than "pay".

            The dock is the same one Checkout uses one screen earlier, down to
            the class list, so the primary action does not move between the two
            screens. `safe-bottom` keeps it clear of the home indicator.
          */}
          <div className="action-dock sticky bottom-0 z-20 px-5 pb-4 pt-2 safe-bottom">
            {/*
              THE SAME RED PILL AS THE BUTTON THAT LED HERE.

              This was `glass-action-ink` — a near-black fill — and it was the
              only primary action in the customer app that was not the brand
              red. The screen before this one ends with a red pill reading "Pay
              Now & Place Order"; tapping it landed on a black pill reading
              "Pay ₹208.95", same width, same radius, same place on the screen.
              Identical shape in a different colour reads as a different KIND of
              action, which is the one thing it must not do at the step where
              money moves.

              So this is now character-for-character Checkout's CTA, and
              `text-on-brand` replaces `text-page`: the latter is the page
              background colour, which only passes for white by coincidence in
              the light theme and is a dark grey in the dark one.
            */}
            <button
              onClick={payNow}
              disabled={simulate.isPending}
              className="pressable glass-action w-full rounded-full text-on-brand py-4 px-6
                         flex items-center justify-center gap-2.5 disabled:opacity-45"
            >
              <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
                <rect
                  x="4.5"
                  y="10.5"
                  width="15"
                  height="9.5"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.9"
                />
                <path
                  d="M8 10.5V7.5a4 4 0 118 0v3"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                />
              </svg>
              <span className="font-bold text-[16px]">
                Pay {formatINR(intent.data.amountPaise)}
              </span>
            </button>

            <p className="text-[11px] text-ink-400 text-center mt-3 flex items-center justify-center gap-1.5">
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden>
                <path
                  d="M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6l7-3z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
              Your card details never reach us
            </p>
          </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- waiting
  return (
    <Screen title="Payment" subtitle="Do not close this page">
      <Card className="p-7 text-center mb-4">
        <p className="eyebrow text-[11px] text-ink-500">Amount to pay</p>
        <p className="display text-[44px] text-ink-900 tnum mt-2">
          {formatINR(intent.data.amountPaise)}
        </p>
      </Card>

      {noProvider ? (
        <Card className="p-5 mb-4 border-2 border-warn-500">
          <p className="text-[17px] font-bold text-ink-900">Payments are not switched on yet</p>
          <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
            Nothing has been charged and your order has not been placed. This venue is not taking
            payments through the app at the moment — please order at the counter.
          </p>
          <button
            onClick={() => navigate('/checkout')}
            className="pressable glass-on mt-4 w-full rounded-xl border border-ink-200 text-ink-700
                       font-semibold text-[14px] py-3"
          >
            Back to your basket
          </button>
        </Card>
      ) : handoffError ? (
        /*
          THE HANDOFF BROKE, WHICH IS NOT A DECLINE.

          `warn`, not `alert`, and the word "declined" appears nowhere. Nobody
          refused this payment — the payment screen never opened. Telling a
          customer their payment failed when their network dropped a script
          sends them to find another card for a problem another tap would fix.

          The retry is the filled button, because retrying is almost always the
          right move here and it should be the thing under their thumb.
        */
        <Card className="p-5 mb-4 border-2 border-warn-500">
          <p className="text-[17px] font-bold text-ink-900">
            The payment screen did not open
          </p>
          <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
            Nothing has been charged. This is usually a network hiccup — please try again.
          </p>
          <p className="text-[12px] text-ink-400 mt-2">{handoffError}</p>
          <button
            onClick={payNow}
            className="pressable glass-action w-full rounded-xl text-on-brand font-bold text-[15px] py-3.5 mt-4"
          >
            Try again
          </button>
          <button
            onClick={() => navigate('/checkout')}
            className="pressable glass-on mt-2 w-full rounded-xl border border-ink-200 text-ink-700
                       font-semibold text-[14px] py-3"
          >
            Back to your basket
          </button>
        </Card>
      ) : failed ? (
        <Card className="p-5 mb-4 border-2 border-alert-500">
          <p className="text-[17px] font-bold text-ink-900">
            {settled === 'EXPIRED' ? 'The payment window closed' : 'That payment did not go through'}
          </p>
          <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
            {settled === 'EXPIRED'
              ? 'Nothing was charged and nothing was declined — it simply timed out.'
              : 'Nothing has been charged. You can try again.'}
          </p>
          <button
            onClick={() => navigate('/checkout')}
            className="pressable glass-action mt-4 w-full rounded-xl text-on-brand font-bold
                       text-[15px] tracking-wide py-3.5"
          >
            TRY AGAIN
          </button>
        </Card>
      ) : stuck ? (
        <Card className="p-5 mb-4 border-2 border-alert-500">
          <p className="text-[17px] font-bold text-ink-900">We cannot confirm this payment</p>
          <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
            Nothing has been taken that we can see, but we are not certain, so we will not
            guess. Please show this screen at the counter and somebody will sort it out.
          </p>
          <p className="text-[12px] text-ink-400 mt-3 tnum">Reference: {settled}</p>
          <button
            onClick={() => navigate('/orders')}
            className="pressable glass-action mt-4 w-full rounded-xl text-on-brand font-bold
                       text-[15px] tracking-wide py-3.5"
          >
            YOUR ORDERS
          </button>
        </Card>
      ) : slow ? (
        <Card className="p-5 mb-4 border-2 border-warn-500">
          <p className="text-[17px] font-bold text-ink-900">This is taking longer than usual</p>
          <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">
            Your payment may still be going through. Nothing is lost — we will confirm it the
            moment we hear back.
          </p>
          <button
            onClick={() => void status.refetch()}
            disabled={status.isFetching}
            className="pressable glass-action mt-4 w-full rounded-xl text-on-brand font-bold
                       text-[15px] tracking-wide py-3.5 disabled:opacity-50"
          >
            {status.isFetching ? 'CHECKING…' : 'CHECK AGAIN'}
          </button>

          {/*
            TWO ACTIONS, BECAUSE THERE ARE TWO REASONS TO BE HERE.

            Either the payment is genuinely in flight — in which case asking the
            server again is the only useful move — or the customer closed the
            checkout and nothing is happening at all. One button cannot serve
            both, and the second case previously had no way out at all: the Pay
            button is gone by now, and "check again" polls something that will
            never change.

            SECOND and unfilled, on purpose. If a payment really is settling,
            opening a fresh checkout is the wrong thing to reach for, so the
            safe action keeps the thumb position.
          */}
          {cashfreeSession(intent.data?.checkoutPayload) ? (
            <button
              onClick={payNow}
              className="pressable glass-on mt-2 w-full rounded-xl border border-ink-200 text-ink-700
                         font-semibold text-[14px] py-3"
            >
              Open the payment screen again
            </button>
          ) : null}
          {/* Asks the SERVER, which asks the provider. Still nothing the client
              asserts — the button reruns the same query the page has been
              polling, it does not claim an outcome. */}
        </Card>
      ) : (
        <Card className="p-5 mb-4">
          <Spinner label="Confirming your payment…" />
          {/* The single most valuable sentence on this screen. PRD §9 case A is
              a customer who pays and closes the browser; the webhook confirms
              regardless. Saying so removes the anxiety that keeps someone
              staring at a spinner. */}
          <p className="text-[13px] text-ink-500 mt-3 text-center leading-relaxed">
            If you have already paid you can leave this page. We will still get the
            confirmation and your order will start.
          </p>
        </Card>
      )}

      {/*
        THE DEV WEBHOOK FORGER, HIDDEN WHEN A REAL PROVIDER IS WIRED.

        `import.meta.env.DEV` alone was the wrong gate. With Cashfree
        configured, a development build still showed this button and pressing it
        got the server's correct refusal:

            RECONCILIATION_REQUIRED
            "Payment simulation only works against the stub provider."

        A control that is visible and cannot work is worse than an absent one —
        it reads as a broken feature rather than an inapplicable one. The
        presence of a `paymentSessionId` is the honest test: it means the server
        handed us a real checkout, so there is nothing to forge.
      */}
      {import.meta.env.DEV && !cashfreeSession(intent.data?.checkoutPayload) && !failed && !stuck ? (
        <div className="rounded-card border border-dashed border-warn-500 bg-warn-50 p-4">
          <p className="text-[11px] text-ink-400 leading-relaxed">
            Development: no aggregator is wired, so tapping Pay makes the server forge a
            stub-provider webhook and run it through the real verification path — the same code
            a live Razorpay event would take. The button is the handoff; the webhook is what
            confirms.
          </p>

          {/* A manual re-fire, once the first one has visibly not worked.
              Without it a webhook that failed leaves a spinner and no way
              forward. */}
          {slow ? (
            <button
              onClick={() => simulate.mutate()}
              disabled={simulate.isPending}
              className="pressable glass-on mt-3 w-full rounded-xl border border-ink-200 py-3
                         text-[13px] font-bold text-ink-700 disabled:opacity-50"
            >
              {simulate.isPending ? 'SENDING WEBHOOK…' : 'SEND THE WEBHOOK MANUALLY'}
            </button>
          ) : null}

          {simulate.isError ? <ErrorState error={simulate.error} /> : null}
        </div>
      ) : null}
    </Screen>
  );
}
