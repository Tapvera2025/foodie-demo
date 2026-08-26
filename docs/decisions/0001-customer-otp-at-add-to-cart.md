# DR-0001 — Customer authentication by mobile OTP, triggered at add-to-cart

**Status:** Accepted · 12 August 2026
**Supersedes:** the "no account, ever" positioning in PRD v5.2 and v6.1 §1

---

## The decision

A customer authenticates with **mobile number + OTP**, and the prompt appears at
**add-to-cart** — not at QR scan, and not at checkout.

```
QR → browse court → open stall → browse menu → ADD TO CART → OTP → cart → checkout → pay
```

Browsing is anonymous. Committing is not.

---

## What this retires

The PRD currently claims "no app install, no account" as a differentiator. Half
of that survives; the other half does not. The honest replacement is:

> **No app install. No login until you commit.**

That is still materially better than the alternatives — nobody downloads
anything, and the account is created in one step at the moment the customer has
already decided to buy — but it is a different claim and the document must stop
making the old one.

## Why at add-to-cart rather than at checkout

Later is not automatically better. At checkout the customer has assembled a
basket and is reaching for their wallet; interrupting there competes with the
payment itself and adds a second place the flow can be abandoned. At
add-to-cart the customer has expressed intent but invested almost nothing, and
the interruption costs them one item's worth of momentum rather than a full
basket's.

It also means the cart is server-owned from the moment it exists, which removes
the awkward class of bugs where an anonymous local basket has to be merged into
an authenticated one.

## Why we need an identity at all

Four things that do not work without one, all of which are in pilot scope:

| Need | Why anonymity fails |
| --- | --- |
| Ready notification | WhatsApp and SMS both require a phone number |
| Refunds | A refund to "whoever held that session" is not a refund |
| Support | "My order never came" has no lookup without an identity |
| Order history | Required for the customer to check what they were charged |

The phone number was going to be collected regardless, for the notification
ladder. This decision makes that explicit and moves it earlier.

---

## Consequences

### 1. SMS OTP puts DLT registration on the pilot critical path

**This is the significant one.**

India requires DLT (Distributed Ledger Technology) registration of the sender
entity, header and every template before transactional SMS can be delivered.
It was already on the long-lead list for the *notification* ladder, where a
delay would have degraded an experience.

With OTP at add-to-cart it now gates **order placement itself**. No DLT
registration means no OTP means no order. The pilot cannot run.

Two mitigations, and they are not exclusive:

- **WhatsApp OTP instead of SMS.** Avoids DLT, but has its own Business Service
  Provider onboarding and template approval, measured in weeks.
- **Start DLT registration now**, before the payment aggregator decision, because
  it is calendar-bound rather than work-bound and nothing about it accelerates
  by adding people.

Either way this must start immediately. It is the only pilot dependency where
waiting costs time that cannot be recovered.

### 2. The cart must survive authentication

The customer taps "Add" on a ₹150 roll, authenticates, and must land back
looking at a cart containing that roll. Losing it is the single most likely way
to make this change feel worse than no auth at all.

### 3. The `customer` table stops being unused

It exists in the schema and has never been queried. It now carries the phone
number, and `app_session.customer_id` — currently always null — becomes the link
between an anonymous browse and an identified order.

Sessions therefore have two phases: anonymous while browsing, attached once
authenticated. The session id does not change on authentication.

### 4. New surface that must be built

- OTP issue and verify endpoints, with the OTP hashed at rest and short-lived
- **Rate limiting on OTP send**, per number and per IP. An unauthenticated
  endpoint that sends paid SMS is an endpoint someone will use to spend our
  money. Nothing is rate-limited today, so this is the first place it becomes
  mandatory rather than advisable
- Attempt limiting on verify, to stop brute-forcing a six-digit code
- A customer token type — `tokens.ts` currently has session, device and staff
- Order history, scoped to the authenticated customer

### 5. It resolves the pickup-token question

PRD v6.1 §22 left open whether a guessable order number is an adequate
collection credential. With an authenticated customer the order is tied to a
known identity, so the order number can stay human-sayable while the actual
proof lives in the customer's own order screen. The open question closes without
needing a separate token.

### 6. Rejected alternative: guest checkout with phone, no OTP

Collect the number, do not verify it. Cheaper, avoids DLT entirely, and it is
what a lot of Indian ordering flows actually do.

Rejected because an unverified number is worthless for exactly the cases it
would be collected for: a mistyped digit means the ready notification goes to a
stranger, the refund cannot be traced, and support has nothing to look up. It
also invites a customer to enter a fake number to skip the step, which produces
data that looks present and is not.

---

## What changes in the built system

| Area | Change |
| --- | --- |
| `customer` table | First real use; carries the verified phone number |
| `app_session` | `customer_id` populated on authentication |
| PWA | OTP screen; cart persists across it; order history |
| `tokens.ts` | A fourth token type for customers |
| Rate limiting | Introduced, starting with OTP send |
| PRD v6.1 §1, §4.1 | The "no account" claim and the journey table |
| Long-lead list | DLT registration promoted to blocking |
