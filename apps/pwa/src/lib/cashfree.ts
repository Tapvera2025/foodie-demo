/**
 * ============================================================================
 * LOADING CASHFREE'S CHECKOUT SDK, AND KNOWING WHAT ITS ANSWER IS WORTH
 * ============================================================================
 *
 * The server creates a Cashfree order and hands back a `payment_session_id`.
 * This module turns that into a checkout the customer can pay through.
 *
 * ----------------------------------------------------------------------------
 * WHY A LOADER AND NOT A `<script>` IN index.html
 * ----------------------------------------------------------------------------
 *
 * Because almost nobody who opens this app is going to pay in the next thirty
 * seconds. They scanned a QR code at a table to READ A MENU. Putting the
 * aggregator's SDK in the document head makes every one of those people
 * download and execute a third-party payment script, on food-court wi-fi, to
 * look at a list of momos.
 *
 * Loading it at the moment somebody taps Pay costs a few hundred milliseconds
 * once, for the minority who get that far, and it keeps a third party out of
 * the critical path of the thing the app is actually for.
 *
 * ----------------------------------------------------------------------------
 * THE SDK'S RESULT IS NOT EVIDENCE
 * ----------------------------------------------------------------------------
 *
 * `checkout()` resolves with what the browser thinks happened. That is a claim
 * from an untrusted, interruptible place: the customer can close the modal at
 * the exact moment the bank confirms, the phone can lose signal between the
 * debit and the callback, and a UPI app can return "success" before the money
 * actually moves.
 *
 * So `startCheckout` deliberately returns only "the handoff finished" — never
 * "the payment succeeded". The server learns the truth from a signed webhook,
 * and the screen learns it by asking the server. `api.paymentStatus` is the
 * authority; this function is a door.
 */

/**
 * Cashfree's global, narrowed to what is used here.
 *
 * Typed by hand rather than pulled from `@cashfree/cashfree-js`, because the
 * npm package would be bundled into every visitor's download and undo the whole
 * point of loading it lazily.
 */
type CashfreeCheckoutOptions = {
  paymentSessionId: string;
  /**
   * `_modal` keeps the customer inside the PWA.
   *
   * `_self` navigates the page away, which on a phone means the app is torn
   * down mid-payment and rebuilt on return — losing the in-memory customer
   * token and landing them on a screen that asks them to verify again, holding
   * a receipt. The modal keeps this tab alive, so the status poll that decides
   * the outcome never stops running.
   */
  redirectTarget?: '_modal' | '_self' | '_blank';
};

type CashfreeInstance = {
  /**
   * The second parameter is `checkForPayFast`, and it is undocumented.
   *
   * Read out of the v3 SDK bundle itself (`version()` reports 2026.05.12),
   * because three hypotheses had already been wrong and their published
   * reference does not mention it:
   *
   *     checkout: function e(r, s = !0) { …
   *       let y = { payment_session_id: r.paymentSessionId, …, checkForPayFast: s };
   *       if ((v.myWidth >= 768 || "inline" === g) && (y.checkForPayFast = !1), …
   *
   * It defaults to TRUE, and the SDK only forces it false when the viewport is
   * at least 768px wide. So it is true on precisely one class of device: a
   * phone — which is the only device this app has.
   *
   * The SDK itself passes `false` on its own internal re-entry (`e(r, !1)`),
   * so this is a supported value rather than a private flag.
   */
  checkout(
    options: CashfreeCheckoutOptions,
    checkForPayFast?: boolean,
  ): Promise<{
    error?: { message?: string };
    redirect?: boolean;
    paymentDetails?: { paymentMessage?: string };
  }>;
};

type CashfreeFactory = (options: { mode: 'sandbox' | 'production' }) => CashfreeInstance;

declare global {
  interface Window {
    Cashfree?: CashfreeFactory;
  }
}

const SDK_URL = 'https://sdk.cashfree.com/js/v3/cashfree.js';

/**
 * How long to wait for a third party's script before giving up.
 *
 * Without this the promise never settles on a dead network and the Pay button
 * spins for ever with nothing to explain it. Ten seconds is past the point
 * where the SDK was ever going to arrive.
 */
const LOAD_TIMEOUT_MS = 10_000;

/**
 * One in-flight load, shared.
 *
 * A double-tap would otherwise inject two `<script>` tags racing to define the
 * same global. Caching the PROMISE rather than a boolean means the second
 * caller waits for the first load instead of starting another.
 */
let loading: Promise<CashfreeFactory> | null = null;

export class CashfreeLoadError extends Error {}

function loadSdk(): Promise<CashfreeFactory> {
  if (window.Cashfree) return Promise.resolve(window.Cashfree);
  if (loading) return loading;

  loading = new Promise<CashfreeFactory>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const el = existing ?? document.createElement('script');

    const timer = setTimeout(() => {
      /*
       * Clear the cached promise on failure.
       *
       * Otherwise the first bad network permanently poisons the module: every
       * later tap would await a promise that already rejected, and the customer
       * could never retry without reloading the whole app.
       */
      loading = null;
      reject(new CashfreeLoadError('The payment library did not load in time.'));
    }, LOAD_TIMEOUT_MS);

    el.addEventListener('load', () => {
      clearTimeout(timer);
      if (window.Cashfree) {
        resolve(window.Cashfree);
      } else {
        // The script loaded and defined nothing we recognise — a CDN serving an
        // error page with a 200, or a version that renamed its global.
        loading = null;
        reject(new CashfreeLoadError('The payment library loaded but is not usable.'));
      }
    });

    el.addEventListener('error', () => {
      clearTimeout(timer);
      loading = null;
      reject(new CashfreeLoadError('The payment library could not be reached.'));
    });

    if (!existing) {
      el.src = SDK_URL;
      el.async = true;
      document.head.appendChild(el);
    }
  });

  return loading;
}

/**
 * What the server puts in `checkoutPayload`. See `cashfree.provider.ts`.
 *
 * Read defensively rather than cast: this crosses a network boundary, and an
 * older cached build of the app talking to a newer server is a real state a
 * PWA gets into. A missing session id must read as "not a Cashfree payload"
 * rather than as `undefined` handed to a payment SDK.
 */
export function cashfreeSession(
  payload: Record<string, unknown> | undefined,
): { paymentSessionId: string; mode: 'sandbox' | 'production' } | null {
  const id = payload?.['paymentSessionId'];
  if (typeof id !== 'string' || id.length === 0) return null;

  const mode = payload?.['mode'];
  return {
    paymentSessionId: id,
    // Default to sandbox on an unrecognised value: the failure of guessing
    // wrong that way is a payment that does not work, rather than one that
    // takes real money in a test environment.
    mode: mode === 'production' ? 'production' : 'sandbox',
  };
}

export type HandoffResult =
  /** The customer came back. Says NOTHING about whether they paid. */
  | { outcome: 'RETURNED' }
  /** The SDK reported an explicit failure of the handoff itself. */
  | { outcome: 'FAILED'; message: string };

/**
 * Open Cashfree's checkout and wait for the customer to come back.
 *
 * Resolving does not mean the payment worked, and neither does an absent error
 * — see the note at the top of this file. The caller polls the server.
 */
export async function startCheckout(session: {
  paymentSessionId: string;
  mode: 'sandbox' | 'production';
}): Promise<HandoffResult> {
  const Cashfree = await loadSdk();
  const cashfree = Cashfree({ mode: session.mode });

  /*
   * ==========================================================================
   * `false` — DO NOT ASK FOR A FAST-PAY LIST
   * ==========================================================================
   *
   * THE CRASH THIS IS FOR
   *
   *     TypeError: Cannot read properties of undefined (reading 'orderCurrency')
   *         at Array.map (<anonymous>)          checkout/:99
   *
   * Cashfree's hosted checkout showed "Something went wrong" for every payment
   * on a phone. Everything checkable said the order was fine — ACTIVE, correct
   * currency, fourteen eligible payment methods, valid session, matching
   * environment, a return url. `npm run diagnose:session` confirms all of it.
   *
   * `orderCurrency` appears NOWHERE in the SDK bundle — zero matches for
   * "currency" in any casing — so the failure is downstream, on the checkout
   * page the SDK POSTs a form to. What the SDK controls is what goes in that
   * form, and one field is decided by SCREEN WIDTH:
   *
   *     if ((v.myWidth >= 768 || "inline" === g) && (y.checkForPayFast = !1), …
   *
   * `checkForPayFast` defaults true and is only cleared at 768px and above. So
   * their page is asked to build a fast-pay list, maps over it, and reads
   * `orderCurrency` off an entry that is not there — which is the `Array.map`
   * in the stack, and the reason this reproduced on every phone and would not
   * have on a desktop window.
   *
   * Nothing here needs it. Fast-pay is a returning-customer convenience keyed
   * on a customer Cashfree recognises, and `customer_id` is `order_<uuid>` —
   * a new identity per order by design, because a food court customer is
   * anonymous beyond a verified phone (see the note in cashfree.provider.ts).
   * There will never be a saved instrument to offer.
   *
   * Turning it off asks for the thing we actually want: the full payment list.
   */
  const result = await cashfree.checkout(
    {
      paymentSessionId: session.paymentSessionId,
      redirectTarget: '_modal',
    },
    false,
  );

  if (result?.error?.message) {
    return { outcome: 'FAILED', message: result.error.message };
  }

  /*
   * Everything else is RETURNED, including what the SDK calls success.
   *
   * Treating `paymentDetails` as confirmation is the exact mistake PRD §9 case
   * B describes: the client and the webhook are independent channels, the
   * client can be wrong in both directions, and only the webhook is
   * authenticated. The screen shows "checking with the bank" and asks the
   * server, which is slower to look at and impossible to fool.
   */
  return { outcome: 'RETURNED' };
}
