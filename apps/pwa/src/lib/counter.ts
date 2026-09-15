/**
 * Paying at a till instead of on the phone.
 *
 * `PAYMENTS_PROVIDER=pos` opens a payment intent like any other provider — the
 * server needs the `provider_order_ref` before a cashier can charge anything,
 * and `/pos/orders/:id/charge` refuses without one ("The customer must tap Pay
 * first"). What it does NOT give back is anything to hand off to: no SDK to
 * load, no redirect to follow, no deep link to open.
 *
 * The entire client-side payment step is a sentence telling somebody where to
 * walk, and the money moves when a cashier taps Charge on the terminal. The
 * confirmation still arrives the only way it ever does — a signed provider
 * event through the webhook — so the status poll on the Pay screen is what
 * notices, exactly as it does for a customer returning from a UPI app.
 */
export function payAtCounter(payload: Record<string, unknown> | undefined): boolean {
  return payload?.['method'] === 'PAY_AT_COUNTER';
}
