-- migrate:up
-- =============================================================================
-- THE PROVIDER'S CHECKOUT PAYLOAD HAS TO BE KEPT, NOT REBUILT FROM MEMORY
-- =============================================================================
--
-- `createIntent` returns an existing live intent rather than opening a second
-- one — correct, and PAY-REC-03 requires it. But it had nowhere to keep what
-- the provider handed back, so on that path it INVENTED a payload:
--
--     checkoutPayload: { provider: this.provider.name, ref: live.provider_order_ref }
--
-- which is a description of the intent, not the thing a checkout SDK needs.
--
-- THE FAILURE THIS PRODUCED
--
-- Cashfree's payload carries `payment_session_id`; that id is the entire
-- handoff, it is issued once at order creation, and it cannot be reconstructed
-- from anything stored. So:
--
--   1. Checkout calls payment-intent  -> intent CREATED, real payload, correct
--   2. the pay screen mounts and calls payment-intent again
--   3. an intent already exists       -> the fabricated payload comes back
--   4. no payment_session_id          -> the client cannot open a checkout
--
-- Step 2 is not a mistake by the client. The endpoint is documented as safe to
-- call twice and the pay screen is where a customer lands after a reload, a
-- return from a UPI app, or a shared link. Every real payment took this path,
-- so every real payment failed at the last step — with the client falling back
-- to whatever it does when no session is present.
--
-- It stayed hidden because the stub provider's payload has nothing in it that
-- matters. Fabricating `{provider, ref}` is indistinguishable from the real
-- thing when the real thing is also just a reference.
--
-- -----------------------------------------------------------------------------
-- WHY STORING IT IS SAFE
-- -----------------------------------------------------------------------------
--
-- A payment session id is single-use and scoped to one order, and it is already
-- sent to the customer's browser — which is a far more exposed place than a
-- row in this database. Keeping it server-side adds no exposure and removes a
-- class of bug where the server cannot answer a question it has already been
-- asked once.
--
-- JSONB rather than TEXT because the payload is provider-shaped and differs per
-- aggregator: this column must not acquire a schema of its own, or swapping
-- providers becomes a migration.

ALTER TABLE payment
  ADD COLUMN checkout_payload JSONB;

COMMENT ON COLUMN payment.checkout_payload IS
  'Exactly what the provider returned for the client to open a checkout with '
  '(Cashfree: payment_session_id). Stored so that re-requesting a live intent '
  'returns the real payload rather than a reconstruction. Single-use and '
  'order-scoped; already given to the browser.';

-- migrate:down
ALTER TABLE payment DROP COLUMN IF EXISTS checkout_payload;
