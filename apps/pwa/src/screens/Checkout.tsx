import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';
import { ApiError } from '../lib/api';
import { cashfreeSession } from '../lib/cashfree';
import { formatINR } from '../lib/money';
import { useCart } from '../lib/cart';
import { Card, ErrorState, FoodTile, Spinner } from './ui';

/**
 * Review and pay.
 *
 * THE BILL BLOCK, AND THE ONE THING IT MUST NOT DO
 *
 * PRD CUS-PRICE-02: no charge may appear for the first time on the payment
 * screen. That is why the totals come from `/checkout/validate` rather than
 * being summed here — this runs the same pricing code the invoice will, so the
 * fee and the tax shown are the ones that will be charged rather than a
 * client-side approximation that rounds differently.
 *
 * The bill collapses tax and fees into one "Taxes and charges" line, which is
 * what every food app in India does and what the reference shows. That is only
 * acceptable because the line EXPANDS: the breakdown is one tap away on the
 * same screen, not on a later one. A collapsed summary with no way to open it
 * would be the exact thing CUS-PRICE-02 forbids, dressed as tidiness.
 *
 * Zero-value lines are hidden rather than shown as ₹0. A platform fee of zero
 * is not a fee, and listing one invites the customer to wonder when it stops
 * being zero.
 */
export function Checkout() {
  const navigate = useNavigate();
  const { sessionId, vendorId, vendorName, lines } = useCart();

  /**
   * ==========================================================================
   * THE PHOTOGRAPHS, AND WHY THEY ARE LOOKED UP RATHER THAN ONLY STORED
   * ==========================================================================
   *
   * The basket line carries `imageUrl` now, which fixes every basket built from
   * today onward. It does nothing for the ones already sitting in people's
   * browsers — the store is persisted, so a basket assembled yesterday has the
   * old shape and would keep drawing the grey gradient until the customer
   * happened to re-add the same dish.
   *
   * So this reads the menu as well. `queryKey: ['menu', vendorId]` is the SAME
   * key the stall page uses, so for anyone who arrived the normal way this is a
   * cache hit and costs nothing; for a cold arrival it is one request the page
   * does not block on.
   *
   * The stored value still WINS. A photograph is decoration and the snapshot is
   * the record — but if the stall replaced a dish photo an hour ago, the live
   * one is the better picture, and falling back to it rather than preferring it
   * keeps the rule simple: the basket is what you put in it.
   */
  const menu = useQuery({
    queryKey: ['menu', vendorId],
    queryFn: () => api.menu(vendorId!),
    enabled: Boolean(vendorId),
    staleTime: 60_000,
  });

  const photoFor = (menuItemId: string): string | null => {
    for (const c of menu.data?.categories ?? []) {
      for (const i of c.items) if (i.id === menuItemId) return i.imageUrl;
    }
    return null;
  };
  const setQuantity = useCart((s) => s.setQuantity);
  const beginCheckout = useCart((s) => s.beginCheckout);
  const endCheckout = useCart((s) => s.endCheckout);
  const resetCheckoutKey = useCart((s) => s.resetCheckoutKey);

  const orderLines = lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity }));

  /** True once the order is written. See the guard below. */
  const [placed, setPlaced] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  /**
   * An empty basket means the back button or a stale link, so send them
   * somewhere useful.
   *
   * THE `placed` GUARD IS NOT DEFENSIVE PROGRAMMING — WITHOUT IT THIS BREAKS.
   *
   * Placing an order calls `endCheckout()`, which empties the cart, which makes
   * this condition true, which navigates to the stall list. That redirect then
   * races the one to the payment screen and wins, because it is issued from an
   * effect that runs after the state change.
   *
   * The symptom was "Pay now takes me back to the stalls" and the order was
   * actually placed and paid for every time — it just never showed anyone.
   *
   * The general shape, worth recognising again: an effect that redirects on an
   * empty state, plus an action whose SUCCESS produces that empty state. The
   * two are indistinguishable to the effect unless it is told which is which.
   */
  useEffect(() => {
    if (!placed && lines.length === 0) navigate('/court', { replace: true });
  }, [placed, lines.length, navigate]);

  const quote = useQuery({
    queryKey: ['quote', sessionId, vendorId, orderLines],
    queryFn: () => api.quote(vendorId!, orderLines),
    enabled: Boolean(sessionId && vendorId && orderLines.length > 0),
  });

  /**
   * ==========================================================================
   * ONE TAP: PLACE THE ORDER, THEN PAY IT
   * ==========================================================================
   *
   * The customer used to land on `/pay` and be asked a second time for a
   * decision they had already made — "Place order" on one screen, "Pay" on the
   * next, for the same amount they had just read on the same bill.
   *
   * They are still two SERVER steps and they have to be. `placeOrder` writes
   * the order, prices it and balances its ledger rows; the payment intent is
   * created AGAINST that order id, so the order must exist before anything can
   * charge for it. What is gone is the screen in the middle.
   *
   * ==========================================================================
   * THE PAY SCREEN STILL EXISTS, AND MUST
   * ==========================================================================
   *
   * It is no longer on the happy path. It is:
   *
   *   the RETRY   `/pay/:id` is where "Complete payment" on the tracking screen
   *               goes for an order stuck in PAYMENT_PENDING
   *   the FALLBACK  if any step below fails, the customer is sent there rather
   *               than left on a checkout screen with an order already written
   *   the RETURN  when a real aggregator is wired, it is the address the
   *               customer comes back to after leaving for a UPI app
   *
   * Deleting it would mean an abandoned payment has nowhere to resume from,
   * which is the one failure this flow must not have — the money is the
   * customer's and the order is already in the database.
   */
  const place = useMutation({
    mutationFn: async () => {
      const order = await api.placeOrder(vendorId!, orderLines, beginCheckout());

      /*
       * The intent, then the handoff, in one go.
       *
       * `paymentIntent` is safe to call twice — the server returns the existing
       * live intent rather than opening a second one (PAY-REC-03) — so a retry
       * from the pay screen after a failure here does not double-charge.
       */
      const intent = await api.paymentIntent(order.orderId);

      /*
       * ====================================================================
       * SIMULATE ONLY WHEN THERE IS NOTHING REAL TO HAND OFF TO
       * ====================================================================
       *
       * This was `if (import.meta.env.DEV) simulate()`, unconditionally. The
       * moment a real aggregator was configured, a development build still
       * tried to forge a payment and the server — correctly — refused:
       *
       *     RECONCILIATION_REQUIRED
       *     "Payment simulation only works against the stub provider."
       *
       * The server's refusal is right and the client's request was wrong.
       * `import.meta.env.DEV` answers "is this a development BUILD", which is
       * not the question. The question is "did the server give me a real
       * checkout to open", and the intent response already answers it: a
       * Cashfree intent carries a `paymentSessionId`, a stub one does not.
       *
       * Asking the response rather than the build also means a developer with
       * sandbox credentials exercises the real handoff — which is the entire
       * reason they configured them.
       */
      const session = cashfreeSession(intent.checkoutPayload);

      if (!session && import.meta.env.DEV) {
        // Stands in for the provider, not for the customer. It forges an event
        // through the REAL ingestion path, so the server still learns the
        // outcome the only way it ever does: from a verified provider event.
        await api.simulatePayment(order.orderId);
      }

      return { ...order, handedOff: session !== null };
    },

    /*
     * A KEY THE SERVER WILL NEVER ACCEPT IS DISCARDED, NOT RETRIED.
     *
     * Placement replays a persisted idempotency key so a retry reaches the same
     * order instead of placing a second one. If that key belongs to a different
     * customer the server refuses it — correctly — and no retry can ever
     * succeed: every attempt replays the same refusal and the basket is stuck
     * for good, because the key outlives the in-memory customer token.
     *
     * Clearing it here makes the NEXT tap place a fresh order. The lines are
     * untouched: the customer still wants the food, and the only thing thrown
     * away is a receipt number for an order they cannot claim.
     */
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'TENANT_SCOPE_VIOLATION') {
        resetCheckoutKey();
      }
    },

    onSuccess: (order) => {
      // BEFORE endCheckout(), which empties the cart and would otherwise trip
      // the guard above.
      setPlaced(true);
      endCheckout();

      /*
       * DEV goes to tracking; production goes to the pay screen.
       *
       * No aggregator is wired yet. In production the handoff has not happened
       * when this resolves, so sending somebody to a tracking screen would show
       * them an order no kitchen will ever see. The pay screen is where the
       * handoff will live, and it already handles every state after it.
       */
      /*
       * Where to send them follows the same fact, not the build flag.
       *
       * A real provider means there is still a payment to make, so they go to
       * the pay screen and press one button. Only a SIMULATED payment is
       * already complete, and only then is the tracking screen honest — sending
       * somebody to "your order is being prepared" while the money has not
       * moved is the one thing this screen must never do.
       */
      /*
       * ====================================================================
       * `autoStart`: THE PAY SCREEN OPENS THE SHEET ITSELF, WITHOUT A TAP
       * ====================================================================
       *
       * This button says "Pay Now & Place Order" and then landed the customer
       * on a screen whose only content was a second button saying "Pay
       * ₹261.45" over the same total they had just approved. Everything the
       * pay screen showed, this one already shows — the stall in the header,
       * the same bill lines, a richer item row with a photo and a stepper —
       * so the tap bought nothing and read as being asked to pay twice.
       *
       * The flag rather than opening the sheet here: every failure mode of
       * the handoff already has a home on the pay screen — the SDK refusing
       * to load, the session being rejected, the customer dismissing the
       * sheet, the "we have your money and the stall has not been told" case.
       * Opening the checkout from here would mean either duplicating that or
       * losing it. So the pay screen keeps the job and just stops waiting to
       * be asked.
       *
       * IT IS ROUTER STATE, AND THAT IS THE POINT. It does not survive a
       * reload, which is correct: someone reopening `/pay/:orderId` later, or
       * coming back to an order they abandoned unpaid, must get a button and
       * not a payment sheet that appears on its own. "Arrived by tapping pay,
       * one second ago" is exactly the thing being expressed, and it should
       * be forgotten as soon as it stops being true.
       */
      navigate(order.handedOff ? `/pay/${order.orderId}` : `/order/${order.orderId}`, {
        replace: true,
        state: order.handedOff ? { autoStart: true } : undefined,
      });
    },
  });

  if (!sessionId || !vendorId) return <ErrorState error={new Error('No session')} />;

  const q = quote.data;

  /**
   * Tax and fees, as one number.
   *
   * Four components collapse here: GST on food, the platform fee, and GST on
   * that fee. They are genuinely different things — §14.8 treats food and
   * platform-fee GST under separate rules — which is exactly why the expansion
   * exists rather than the summary being the whole story.
   */
  const chargesPaise = q
    ? q.foodTaxPaise + q.customerFeePaise + q.customerFeeTaxPaise
    : 0;

  return (
    <div className="flex-1 flex flex-col bg-page">
      <div className="flex-1 w-full px-5 pt-5 pb-4">
        {/* ================================================= who this is for */}
        <button
          onClick={() => navigate(-1)}
          className="pressable eyebrow text-[10px] text-ink-500 hover:text-ink-900 mb-1"
        >
          ← Ordering from
        </button>

        <h1 className="display text-[30px] text-ink-900">{vendorName ?? 'Your order'}</h1>

        {/*
          The one-stall rule, stated where it binds.
          The basket already enforces it and the server refuses a cross-vendor
          order outright (CROSS_VENDOR_CART). Saying so here turns a rule people
          discover by having something taken away into one they were told.
        */}
        {/*
          A LINE, NOT A FILLED PILL.

          It was a grey capsule directly under the stall name, which gave a rule
          most people never bump into the same weight as the thing they came
          here to do. It is still said — a rule you discover by having something
          taken away is worse than one you were told — but it is said quietly,
          in the place a caption goes.
        */}
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-ink-500 leading-snug">
          <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 mt-0.5" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
            <path d="M12 11v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="12" cy="7.75" r="1" fill="currentColor" />
          </svg>
          One stall per order. Anything from another stall is a separate order.
        </p>

        {/* ============================================================ items
            ONE CARD, HAIRLINE-SEPARATED ROWS — not a card per line.

            A basket of three dishes was three white cards floating on grey,
            each with its own shadow, then a fourth dashed box, then a fifth
            card for the bill. Five objects for what is one list and one total.

            The rows are the same shape as the menu's, which is where the
            customer just came from, and "Add more items" is now the LAST ROW of
            the same card rather than a separate dashed panel — it belongs to
            the list it adds to.
        */}
        <Card className="mt-6 overflow-hidden">
        <ul>
          {lines.map((l) => (
            <li key={l.menuItemId} className="border-b border-ink-100">
              {/*
                THE ROW: photograph, then what it is and what it costs, then the
                stepper. `items-center` rather than `items-start` — three
                elements of different heights on one line want a shared centre,
                and top-aligning made the stepper float above a 76px tile.
              */}
              <div className="p-3.5 flex items-center gap-3.5">
                {/* Stored first, looked up second. See the note on `photoFor`:
                    baskets built before the line carried a photo are still in
                    people's browsers, and this is what makes them heal. */}
                <FoodTile
                  name={l.name}
                  imageUrl={l.imageUrl ?? photoFor(l.menuItemId)}
                  size="md"
                />

                <div className="min-w-0 flex-1">
                  <p className="font-bold text-[15px] text-ink-900 leading-snug">{l.name}</p>
                  <p className="text-[15px] font-bold text-ink-900 tnum mt-1">
                    {formatINR(l.pricePaise * l.quantity)}
                    {/* The unit price only when it differs from the line total,
                        i.e. when there is more than one. Showing "₹199 each"
                        beside "₹199" is a line of noise. */}
                    {l.quantity > 1 ? (
                      <span className="ml-2 text-[12px] font-medium text-ink-500">
                        {formatINR(l.pricePaise)} each
                      </span>
                    ) : null}
                  </p>
                </div>

                {/*
                  ONE CONTROL, NOT TWO.

                  There was a stepper here AND a floating × in the card's top
                  right corner. The × existed for a real reason — pressing −
                  on the last one and watching the row vanish reads as an
                  accident rather than a decision — but a control pinned to a
                  corner, away from the thing it acts on, is how you get a
                  customer deleting a dish they meant to decrement.

                  So the MINUS becomes a bin at quantity one. Same position,
                  same thumb, and the icon says what will happen before it
                  happens. `aria-label` says it too, because the difference
                  between "remove one" and "remove it" is the whole point and a
                  screen reader cannot see the glyph change.
                */}
                <div className="shrink-0 flex items-center rounded-full bg-ink-100">
                  <button
                    onClick={() => setQuantity(l.menuItemId, l.quantity - 1)}
                    aria-label={
                      l.quantity === 1 ? `Remove ${l.name} from the order` : `Remove one ${l.name}`
                    }
                    className={`pressable glass-hover size-9 grid place-items-center rounded-full ${
                      l.quantity === 1 ? 'text-alert-500' : 'text-ink-700'
                    }`}
                  >
                    {l.quantity === 1 ? (
                      <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                        <path
                          d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                        <path d="M6 12h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                      </svg>
                    )}
                  </button>
                  <span className="w-6 text-center text-[14px] font-bold text-ink-900 tnum">
                    {l.quantity}
                  </span>
                  <button
                    onClick={() => setQuantity(l.menuItemId, l.quantity + 1)}
                    aria-label={`Add one ${l.name}`}
                    className="pressable glass-hover size-9 grid place-items-center rounded-full text-ink-700"
                  >
                    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                      <path
                        d="M12 6v12M6 12h12"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </li>
          ))}

          {/*
            THE LAST ROW OF THE LIST, not a dashed box under it.

            It was a dashed rectangle, and a dashed border means "drop a file
            here" everywhere else in this product — the image pickers all use
            one. Quiet is right: it adds rather than confirms, and a solid
            button would compete with Place Order for the same glance. A row
            with a + in it is quiet without pretending to be a dropzone.
          */}
          <li>
            <button
              onClick={() => navigate(`/vendor/${vendorId}`)}
              /* `rounded-none` is deliberate: this is the last row of a Card
                 that is `overflow-hidden`, so the card's corners cut it. The
                 shape check rejects a film with no shape, and it is right to —
                 saying so here is how the next reader knows which case it is. */
              className="pressable glass-hover rounded-none w-full py-3.5 px-3.5
                         text-[14px] font-semibold text-brand-700
                         flex items-center justify-center gap-2"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
              Add more items
            </button>
          </li>
        </ul>
        </Card>

        {/* ==================================================== bill details */}
        <Card className="p-5 mt-4">
          <h2 className="font-bold text-[15px] text-ink-900">Bill details</h2>
          <hr className="border-ink-100 my-4" />

          {quote.isLoading ? <Spinner label="Working out the total…" /> : null}
          {quote.isError ? (
            <ErrorState error={quote.error} onRetry={() => void quote.refetch()} />
          ) : null}

          {q ? (
            <>
              <div className="flex justify-between items-baseline py-1.5 text-[14px] text-ink-700">
                <span>Item total</span>
                <span className="tnum">{formatINR(q.subtotalPaise)}</span>
              </div>

              <div className="flex justify-between items-baseline py-1.5 text-[14px] text-ink-700">
                <button
                  onClick={() => setShowBreakdown((v) => !v)}
                  aria-expanded={showBreakdown}
                  className="pressable inline-flex items-center gap-1.5 hover:text-ink-900"
                >
                  Taxes and charges
                  <svg viewBox="0 0 24 24" className="size-4 text-ink-400" fill="none" aria-hidden>
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
                    <path d="M12 11v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    <circle cx="12" cy="7.75" r="1" fill="currentColor" />
                  </svg>
                </button>
                <span className="tnum">{formatINR(chargesPaise)}</span>
              </div>

              {/* Every component, named. Closed by default and one tap away —
                  which is what makes the collapsed line above honest. */}
              {showBreakdown ? (
                <div className="pl-3 border-l-2 border-ink-100 ml-1 my-1">
                  <div className="flex justify-between items-baseline py-1 text-[13px] text-ink-500">
                    <span>GST on food</span>
                    <span className="tnum">{formatINR(q.foodTaxPaise)}</span>
                  </div>
                  {q.customerFeePaise > 0 ? (
                    <div className="flex justify-between items-baseline py-1 text-[13px] text-ink-500">
                      <span>Platform fee</span>
                      <span className="tnum">{formatINR(q.customerFeePaise)}</span>
                    </div>
                  ) : null}
                  {q.customerFeeTaxPaise > 0 ? (
                    <div className="flex justify-between items-baseline py-1 text-[13px] text-ink-500">
                      <span>GST on platform fee</span>
                      <span className="tnum">{formatINR(q.customerFeeTaxPaise)}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <hr className="border-ink-100 my-3" />

              <div className="flex justify-between items-baseline">
                <span className="font-bold text-[15px] text-ink-900">To pay</span>
                <span className="display text-[28px] text-ink-900 tnum">
                  {formatINR(q.totalPayablePaise)}
                </span>
              </div>
            </>
          ) : null}
        </Card>

        {/* A promise the system actually keeps: the kitchen does not start until
            a provider event confirms payment, and a stall that refuses triggers
            an automatic refund. Worth saying, because "pay before you have the
            food" is the part a first-time customer hesitates over. */}
        <p className="text-[12px] text-ink-500 leading-relaxed mt-4 px-1">
          One tap places the order and pays for it. The stall starts cooking once the payment is
          confirmed; if they cannot make it, your refund starts on its own — you do not need to
          ask. Collect from the counter when your number is called.
        </p>

        {/*
          RETRYING IS SAFE, and that is `beginCheckout()`'s doing.
          
          It holds one idempotency key for the whole checkout, reused on every
          attempt, so a second press after a failure resolves to the SAME order
          rather than writing another. That matters more now than it did: this
          button places AND pays, so a retry could otherwise mean two orders and
          two charges.
        */}
        {place.isError ? (
          <div className="mt-4">
            <ErrorState error={place.error} onRetry={() => place.mutate()} />
          </div>
        ) : null}
      </div>

      {/* ====================================================== place order */}
      <div className="action-dock sticky bottom-0 z-20 px-4 pb-4 safe-bottom">
        <div className="measure">
          <button
            disabled={!q || place.isPending}
            onClick={() => place.mutate()}
            className="pressable glass-action w-full rounded-full text-on-brand py-4 px-6
                       flex items-center justify-center gap-2.5 disabled:opacity-45"
          >
            {/*
              "CONTINUE TO PAY", NOT "PLACE ORDER".
              
              The button said "Place order", and the next screen then asked the
              customer to pay — which reads as being charged for the same
              decision twice. It is not: this button WRITES the order, and the
              screen after it takes the money. The order has to exist first,
              because a payment intent references it, and because an abandoned
              payment has to leave something behind to come back to.
              
              So the label names what happens NEXT rather than what happens on
              this tap. The customer is not misled about the money — the amount
              is right there beside it — and nobody arrives at the payment
              screen wondering why they are being asked again.
            */}
            <span className="font-bold text-[15px]">
              {place.isPending ? 'Placing Your Order…' : 'Pay Now & Place Order'}
            </span>
            {q ? (
              <>
                <span className="opacity-50" aria-hidden>
                  ·
                </span>
                <span className="font-bold text-[15px] tnum">
                  {formatINR(q.totalPayablePaise)}
                </span>
              </>
            ) : null}
            <svg viewBox="0 0 24 24" className="size-5 ml-0.5" fill="none" aria-hidden>
              <path
                d="M5 12h13M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
