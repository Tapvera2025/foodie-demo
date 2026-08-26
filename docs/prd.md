# Food Court QR Ordering Platform — PRD

**Tapvera Technologies Pvt Ltd**
Version 7.0 · 12 August 2026 · Supersedes PRD v6.1 and every earlier version

> This is the working source of truth. It lives beside the code, diffs in git, and
> is expected to be corrected by the same review that touches the implementation.
> Where a section describes something already built, it says so. Where it
> describes an intention, it says that too — a requirement nobody has implemented
> and one running in a test kitchen are different kinds of claim and must not
> look alike.

---

## 1. What we are building

A customer walks into a food court, scans a QR code on a poster or a stall front,
and sees every stall in that venue on their phone. They pick one, browse its
menu, add something to a basket, verify their mobile number once, pay, and are
told when to collect. The stall receives the ticket on a kitchen tablet. The
customer collects at the counter by order number.

No app install. **No login until you commit** — browsing is anonymous, ordering
is not.

### 1.1 The problem

An Indian food court at lunchtime is a set of parallel queues in front of stalls
that are each idle roughly half the time. A customer joins one queue, waits,
orders, pays, waits again, collects. Wanting a drink from a different stall means
queueing twice. The stall cannot start cooking until the customer reaches the
counter, so the kitchen is throttled by the speed of the till rather than the
speed of the wok.

The waste is symmetric. Customers spend a large share of a short lunch break
standing still. Vendors lose everyone who looks at the queue and leaves — and
never find out how many, because a customer who does not join a queue leaves no
trace.

### 1.2 What changes

| | Today | With the platform |
| --- | --- | --- |
| Deciding | Read a board from a distance, in a queue | Browse every stall, seated |
| Ordering | At the counter, verbally, one stall | On the phone, any stall in the venue |
| Paying | Cash or card at the till | UPI at the point of decision |
| Waiting | Standing at the counter twice | Sitting; notified when ready |
| For the vendor | Throttled by till speed; walk-aways invisible | Kitchen starts on payment; abandoned baskets measurable |
| For the operator | No data beyond footfall | Order volume, peak curves, per-stall performance |

### 1.3 Explicitly not for

- **Delivery.** No riders, no addresses. The customer is in the building.
- **Single restaurants.** The multi-vendor court is the point.
- **Table service.** Collection is at the counter — see §2.1.
- **Cloud kitchens.** No storefront, nothing to scan.

---

## 2. Corrections that shaped this document

Seven defects were found by executing the system rather than reading it. Full
reasoning and the regression guard added for each is in
[`docs/errata.md`](./errata.md). Two matter enough to restate.

### 2.1 The QR belongs to the venue, not the table

Earlier versions gave every table its own QR token and made the table a required
field on every order. That assumed a restaurant: numbered tables, owned by one
kitchen, staying put so food can be carried to them.

A food court is none of that. Seating is shared between every stall, gets
rearranged all day, and no vendor owns any of it — so nobody maintains a sticker
on it, and a token that migrates across the hall is worse than no token. There is
no table service to justify knowing where someone sat.

The **order number** identifies the customer at collection. `court_table`
survives in the schema, unused and nullable, because some venues do have numbered
seating and re-deriving a deleted concept costs a migration against live order
history.

### 2.2 The pattern behind four of the seven

Four guards were present as text and absent as behaviour: a `REVOKE` against a
role that did not exist, a lint rule that resolved no imports, a codegen script
for an uninstalled package, and a `DELETE` trigger that `TRUNCATE` bypasses.

The common structure is **a check whose failure mode is silence**. None of them
errored. They quietly did nothing, and an absence of complaints reads exactly
like success. Every one was introduced by someone writing the correct thing and
never watching it refuse.

The rule that follows is in §17.

---

## 3. Who this is for

| | Wants | Will not tolerate | Reached via |
| --- | --- | --- | --- |
| **Customer** | Food, quickly, without queueing twice | An app install, a surprise charge at payment | A QR code they were going to look at anyway |
| **Kitchen staff** | Tickets readable at a glance with wet hands | A screen needing precision, or one that silently stops updating | A mounted tablet, dark UI, large targets |
| **Vendor owner** | More orders, money on time, a clear statement | Being unable to tell what they were paid and why | Settlement reports, per-order commission |
| **Court operator** | Throughput per square foot, a revenue share | Being blamed for a stall's hygiene or a platform outage | Court console, revenue share |

---

## 4. Module architecture

Four portals over shared platform services. Vendor onboarding and vendor
operations are **the same portal, separate modules** — not separate applications.

```
FOOD COURT ORDERING PLATFORM
│
├── 1. VENDOR PORTAL
│   │
│   ├── Onboarding
│   │   ├── Business Details
│   │   ├── KYC / Compliance
│   │   ├── Settlement Setup
│   │   ├── Menu Setup
│   │   ├── POS Setup
│   │   ├── Staff Setup
│   │   └── Submit for Approval
│   │
│   ├── Vendor Profile
│   │
│   ├── Vendor Settings
│   │   ├── Operating Hours
│   │   ├── Accepting Orders ON/OFF
│   │   ├── Pause Orders
│   │   ├── Preparation Time
│   │   ├── Auto-accept / Manual-accept
│   │   ├── Notification Preferences
│   │   └── Settlement Configuration & Status
│   │
│   ├── Menu Management
│   │   ├── Categories
│   │   ├── Products
│   │   ├── Variants
│   │   ├── Modifiers
│   │   └── Pricing
│   │
│   ├── Availability Management
│   │   ├── Available
│   │   ├── Sold Out
│   │   └── Temporarily Unavailable
│   │
│   ├── Inventory Management
│   │   ├── Daily Stock
│   │   ├── Stock Consumption
│   │   └── Stock History
│   │
│   ├── Order Management / Kitchen Board
│   ├── POS Integration
│   ├── Staff Management
│   └── Vendor Analytics
│
├── 2. USER PORTAL
│   ├── QR / Food Court Discovery
│   ├── Session Management
│   ├── Vendor Discovery
│   ├── Menu Browsing
│   ├── Authentication
│   ├── Cart
│   ├── Checkout
│   ├── Payment
│   ├── Order Tracking
│   ├── Notifications
│   ├── Pickup / Collection
│   ├── Order History
│   └── Support
│       ├── Order Issue
│       ├── Payment Issue
│       ├── Refund Status
│       └── Contact Support
│
├── 3. ADMIN PORTAL              (food-court scoped)
│   ├── Food Court Management
│   ├── QR Management
│   ├── Vendor Management
│   │   ├── Applications
│   │   ├── Approvals
│   │   ├── Active Vendors
│   │   ├── Suspended Vendors
│   │   └── Inactive Vendors
│   ├── Live Order Monitoring
│   ├── Vendor Monitoring
│   ├── User Management
│   ├── Payments
│   ├── Refunds
│   ├── Settlements
│   ├── Reconciliation
│   ├── Analytics
│   ├── Audit & Activity
│   └── System Configuration
│
└── 4. PLATFORM SERVICES
    ├── Identity & Authorization
    ├── QR Resolution
    ├── Session Management
    ├── Menu Service
    ├── Inventory Service
    ├── Cart Service
    ├── Order Engine
    ├── Payment Engine
    ├── Refund Engine
    ├── POS Integration Layer
    ├── Notification Engine
    ├── Order / Pickup Lifecycle
    ├── Ledger & Settlement
    ├── Reconciliation
    ├── Audit Log
    └── Analytics Engine
```

**No separate Kitchen Portal.** The kitchen board is a *view* of Vendor Order
Management, not a fifth portal. It ships today as its own build target
(`apps/kds`) because a mounted tablet and an office browser have opposite
constraints — dark versus light, glove-sized versus mouse-sized — but that is a
deployment and styling decision, not a business boundary. It reads and writes the
same module through the same API, scoped by the same role.

**POS never owns inventory.** Even in POS mode the flow is:

```
POS → POS Adapter → Normalised Menu + Inventory → Platform
```

never `User → POS`. The internal model in §6 is authoritative and a second POS
provider must be an additional adapter, not a second schema. A POS that dictates
the internal shape is one we cannot replace.

### 4.1 Module to code mapping

The dependency direction between modules is enforced by `eslint-plugin-boundaries`,
not by convention. A deliberately illegal import must be reported — see §17.

| Module | Code | State |
| --- | --- | --- |
| Identity & Authorization | `src/identity` | Staff and customer OTP both done; four token types |
| QR Resolution | `src/tenancy` | Done |
| Session Management | `src/tenancy/session.ts` | Done; id survives authentication |
| Menu Service | `src/catalog` | Done |
| Inventory Service | `src/catalog/inventory.controller.ts` | Done; remaining computed, never stored |
| Cart Service | `src/cart` | Library only; no server-side cart |
| Order Engine | `src/ordering` | Done; one guarded transition in `transition.ts` |
| Payment Engine | `src/payments` | Done against the stub; no aggregator chosen |
| Refund Engine | inside `src/payments` | Logic tested; no module |
| POS Integration Layer | — | Deferred, see §16.3 |
| Notification Engine | — | **Not built** |
| Order / Pickup Lifecycle | `src/ordering` | Resolved into order tracking, see §11.5 |
| Ledger / Settlement | `src/ledger` | Ledger done; settlement not built |
| Reconciliation | `reconciliation_item` | Opened by the payment engine; no resolution surface |
| Audit Log | `audit_log` table | Table only, no module |
| Analytics Engine | — | **Not built** |

---

## 5. Vendor lifecycle

Registration is the vendor's work. Approval is the platform's decision. These are
different questions with different owners and must not be conflated.

```
REGISTERED
    ↓
PROFILE_COMPLETED
    ↓
MENU_CONFIGURED
    ↓
PAYMENT_CONFIGURED
    ↓
POS_CONFIGURED  /  MANUAL_MODE
    ↓
SUBMITTED_FOR_APPROVAL      ← vendor's part ends here
    ↓
APPROVED                    ← platform decides
    ↓
ACTIVE                      ← visible to customers
```

A vendor is **never** visible to customers on registration alone.

### 5.1 What onboarding collects

Business name · owner and contact · food court · stall number · logo · cover
image · operating hours · cuisine · GST and tax information · bank and settlement
details · POS information · staff accounts.

### 5.2 The activation gate

`SUBMITTED_FOR_APPROVAL` requires every blocker cleared. This is not form
validation — it is the moment the platform starts accepting money on somebody
else's behalf. Each blocker is something that otherwise fails **after a customer
has paid**.

| Blocker | What goes wrong without it |
| --- | --- |
| Legal name | Invoices and aggregator records disagree with the trading name |
| Settlement mode | A database constraint rejects the order, but only once somebody tries to buy |
| PAN, FSSAI, bank account | The aggregator freezes settlement when money is already in it |
| KYC confirmed | Same, and outside our control to unblock |
| Provider linked account (Mode A only) | The platform collects money with nowhere to forward it — what an RBI-regulated aggregator must not do |
| ≥1 available menu item | The stall shows as open and sells nothing |
| ≥1 staff login | Orders arrive at a kitchen that cannot see them; the escalation ladder fires on every one. **Provisioned by the platform during approval — vendors do not manage their own accounts** |

GSTIN is **optional**: a stall below the registration threshold legitimately has
none, and requiring one excludes exactly the small vendors this exists to serve.
PAN and GSTIN get shape checks only — pretending a regex validates them creates
false confidence where it is most expensive.

### 5.3 Later transitions

| From | To | Note |
| --- | --- | --- |
| APPROVED | ACTIVE | Vendor goes live |
| ACTIVE | SUSPENDED | Reversible. Hygiene issue, settlement dispute |
| SUSPENDED | ACTIVE | Reversible |
| any | INACTIVE | Departure |
| INACTIVE | ACTIVE | **Not permitted** |

No reactivation: bank details, licences and menus all change while a stall is
away, and silently reusing stale settlement details is how money reaches the
wrong account. A returning stall is re-onboarded.

---

## 6. Product, availability and inventory

Three separate concepts. Collapsing them causes a class of problem that is very
hard to unwind later.

| Concept | Field | Values | Means |
| --- | --- | --- | --- |
| **Product status** | `status` | `ACTIVE`, `INACTIVE` | Does this item exist on the menu at all |
| **Availability** | `availability` | `AVAILABLE`, `SOLD_OUT`, `TEMPORARILY_UNAVAILABLE` | Can it be ordered right now |
| **Inventory** | `inventory_mode` | `TRACKED`, `UNTRACKED` | Is a count being kept |

```
Chicken Roll
  Product:      ACTIVE
  Availability: AVAILABLE
  Inventory:    37 / 100 remaining
```

A vendor saying "we're out of chicken rolls today" must not require editing the
menu. Discontinuing an item and running out of it are different actions with
different consequences.

> **Landed**, migration `20260817000008`. `is_available` was dropped rather than
> deprecated — two sources of truth for one fact is how they disagree, and the
> disagreement surfaces as a customer ordering something the kitchen cannot
> make. `unavailable_until` became `available_from`: the same instant said
> forwards, without the double negative at every call site.

### 6.1 Inventory deduction

```
Available stock → Cart → Payment confirmed → DEDUCT
```

Stock is deducted **only on order confirmation**, never on add-to-cart. Ten
people adding the last ten rolls to baskets without paying would otherwise sell
out food nobody bought.

Temporary reservations at checkout are a later refinement, deliberately not in
v1. Today there is no server-side cart at all, so this property holds for free —
it is written down so that adding one does not silently break it.

### 6.2 Two menu modes

**Mode A — POS-sourced.** The vendor's POS is the source for items, prices,
availability, stock and possibly modifiers. The platform consumes and normalises.

**Mode B — Manual.** The vendor manages categories, products, prices, daily stock
directly.

In both cases the internal model is the same and is **not** dictated by any POS:

```
Product · Category · Variant · Modifier · Price · Availability · Inventory
```

`remaining = daily_stock − confirmed_quantity`, computed rather than stored, so
it cannot drift from the orders that produced it.

---

## 7. Order state machine

Status is never assigned. It changes only through a guarded command that takes a
row lock, validates against an allow-list, and appends to `order_status_history`
in the same transaction. An order is reconstructable from its history alone.

```
CREATED → PAYMENT_PENDING → PAYMENT_CONFIRMED → DISPATCHED
        → ACKNOWLEDGED → PREPARING → READY → COLLECTED
```

### 7.1 States

| State | Means |
| --- | --- |
| `CREATED` | Order written, priced, ledger rows in place. No money has moved |
| `PAYMENT_PENDING` | Customer at the payment instrument. Where most abandonment happens |
| `PAYMENT_CONFIRMED` | Payment verified server-side — see §7.4 |
| `DISPATCHED` | Ticket pushed to the stall. Starts the escalation ladder |
| `ACKNOWLEDGED` | Kitchen has it, machine-verified. Stops the ladder |
| `PREPARING` | Cooking started. A real signal, not elapsed time |
| `READY` | Food at the counter. Customer notified |
| `COLLECTED` | Handed over |

`COLLECTED`, not `COMPLETED`. "Cooked" and "handed over" are different events and
the gap between them is a real queue; `COMPLETED` undermined that by being vague
about completed-by-whom. The rename also exposes a missing state: there is no
`ABANDONED` for food made and never collected, which the pilot will produce.

### 7.2 Terminal and error states

| State | Reached from | Consequence |
| --- | --- | --- |
| `PAYMENT_FAILED` | `PAYMENT_PENDING` | Declined. Customer may retry; a retry is a new payment on the same order |
| `PAYMENT_EXPIRED` | `PAYMENT_PENDING` | No outcome in the window. Distinct from failed — nothing was declined, so nothing needs explaining |
| `REJECTED` | `DISPATCHED`, `ACKNOWLEDGED`, `PREPARING` | Kitchen refused. Reason mandatory. Triggers refund |
| `CANCELLED` | `CREATED`, `PAYMENT_PENDING`, `DISPATCHED` | Cancelled before the kitchen committed |
| `DISPATCH_FAILED` | `PAYMENT_CONFIRMED`, `DISPATCHED` | Paid but the stall never received it — §9 Case D |
| `REFUND_PENDING` | `REJECTED`, `CANCELLED`, `DISPATCH_FAILED` | Money owed back. Retried, never abandoned silently |
| `REFUNDED` | `REFUND_PENDING` | Provider confirmed |
| `REFUND_FAILED` | `REFUND_PENDING` | Retries exhausted. Becomes a reconciliation item |
| `RECONCILIATION_REQUIRED` | any | Truth undeterminable. Never resolved automatically |

### 7.3 Who may cause each transition

| From | To | Actor | Authority |
| --- | --- | --- | --- |
| `CREATED` | `PAYMENT_PENDING` | System | On payment intent creation |
| `PAYMENT_PENDING` | `PAYMENT_CONFIRMED` | Payment webhook | Verified signature, never a client claim |
| `PAYMENT_PENDING` | `PAYMENT_FAILED` / `EXPIRED` | Webhook or expiry job | Provider event |
| `PAYMENT_CONFIRMED` | `DISPATCHED` | System | Dispatch worker |
| `DISPATCHED` | `ACKNOWLEDGED` | Vendor device / POS | Machine acknowledgement |
| `ACKNOWLEDGED` | `PREPARING` | Vendor | Staff action |
| `PREPARING` | `READY` | Vendor | Staff action |
| `READY` | `COLLECTED` | Vendor | Staff action |
| `DISPATCHED` / `ACKNOWLEDGED` / `PREPARING` | `REJECTED` | Vendor | Reason mandatory |
| `REJECTED` / `CANCELLED` / `DISPATCH_FAILED` | `REFUND_PENDING` | System | Automatic |
| `REFUND_PENDING` | `REFUNDED` / `REFUND_FAILED` | Payment system | Provider event |
| any | `CANCELLED` | Customer or Manager | Only before the kitchen commits; manager override audited |

### 7.4 The rule that makes this a boundary

> **No client request may transition an order into a financially authoritative
> state.**

`PAYMENT_CONFIRMED`, `REFUNDED` and every ledger-writing transition are reachable
only from a server-verified provider event or a server-initiated process. A
client may ask; it may never assert.

A browser returning from a payment page saying "it worked" is a hint, not
evidence. The client redirect and the provider webhook are independent channels
and only one is authenticated. Treating the redirect as authoritative is how a
platform hands out free food.

---

## 8. Payment state machine

The payment is a **separate object with its own lifecycle**. One order can have
several payment attempts; a payment can be partially refunded while the order
stays `COLLECTED`.

```
CREATED → PENDING → AUTHORIZED → CAPTURED
```

| State | Means |
| --- | --- |
| `CREATED` | Intent recorded, nothing sent |
| `PENDING` | Customer at the instrument. Waiting, not failing |
| `AUTHORIZED` | Funds blocked, not taken |
| `CAPTURED` | Funds taken |
| `FAILED` | Declined. Customer may retry |
| `EXPIRED` | No outcome in the window. Any block released |
| `REFUND_PENDING` | Return initiated |
| `REFUNDED` | Full amount returned |
| `PARTIALLY_REFUNDED` | Some returned — a rejected item within an accepted order |

### 8.1 Why AUTHORIZED and CAPTURED must be distinct

The split-timing configuration is already set to **on acknowledgement**. That is
authorise-then-capture: block the money at checkout, take it when the kitchen
accepts, release it instantly if no stall ever does.

A single `SUCCESS` state cannot represent the interval between those events — and
that interval is the entire mechanism. It is also exactly the shape of UPI
single-block-multi-debit, which this document names as the correct long-term
primitive. Collapsing the two makes the target architecture unimplementable and
hides the difference between "the customer has been charged" and "the customer
could be charged".

> **Landed**, migrations `20260817000006` and `007`. `SUCCESS` and `INITIATED`
> are retired behind a CHECK constraint, since PostgreSQL cannot drop an enum
> label. `succeeded_at` became `captured_at` — it carried the same ambiguity as
> the state it belonged to.
>
> One thing this exposed: `payment_order_uq` was a plain unique index on
> `order_id`, so an order could only ever have one payment row and a retry was
> impossible. It is now partial — one *live* payment per order, with failed and
> expired attempts kept as history. See errata E-006.

### 8.2 The binding rule

> `ORDER.PAYMENT_CONFIRMED` requires `PAYMENT.AUTHORIZED` or `PAYMENT.CAPTURED`,
> verified server-side.

Which of the two suffices depends on the split-timing configuration, and that
dependency is explicit rather than implied by the ordering of code.

---

## 9. Payment failure and recovery

Requirements, not notes. Each will occur in the first week of a pilot.

| ID | Case | Expected |
| --- | --- | --- |
| `PAY-REC-01` | **A** — Customer pays, closes the browser before returning | Webhook confirms; vendor receives the order |
| `PAY-REC-02` | **B** — Frontend reports failure, payment actually succeeded | Server verifies with the provider and proceeds on the true status |
| `PAY-REC-03` | **C** — Customer taps Pay twice | Same idempotency key → one order, one intent, one charge |
| `PAY-REC-04` | **D** — Payment succeeds, dispatch to the stall fails | Retry → escalate → refund if unrecoverable |
| `PAY-REC-05` | Webhook arrives twice, out of order, or delayed | Exactly one state change |
| `PAY-REC-06` | No payment outcome inside the window | Expires; any block released |
| `PAY-REC-07` | Truth undeterminable | `RECONCILIATION_REQUIRED`; a human closes it |

Case B is the one most often missed. The client redirect and the webhook are
independent channels; the client can be wrong in both directions, and only the
webhook is authenticated. The server must be able to ask the provider directly
rather than believing either.

---

## 10. Idempotency

| Operation | Key | Enforced by |
| --- | --- | --- |
| Create order | Client-supplied order key | Unique index. Mandatory; no server fallback |
| Create payment intent | `order_id` | One live intent per order |
| Payment webhook | `provider_event_id` | Unique constraint; rows cannot be deleted |
| Dispatch to stall | `order_id` + attempt | Retries distinguishable from a second ticket |
| Vendor acknowledgement | `order_id` | Repeating is a no-op, not an error |
| Refund | `refund_id` | One refund object per initiation |
| Notification | `event_id` + channel | The same event does not notify twice on one channel |
| OTP send | `phone` + window | Rate-limited; see §11.2 |

> **The invariant:** repeating any external request must not create a second
> order, payment, kitchen ticket, refund, ledger entry or notification. Retrying
> is always safe, and this must be true of the mechanism rather than of the caller
> being careful.

Note the asymmetry: order creation and webhook dedupe are guaranteed by unique
indexes, which hold under concurrency. Acknowledgement idempotency is a status
check inside a row lock — correct, but weaker in kind. Where a database
constraint can carry the guarantee, it should.

---

## 11. Customer journey

### 11.1 Scan to collect

| # | Step | Customer sees | System does |
| --- | --- | --- | --- |
| 1 | Scan | Venue name, list of stalls | Resolves token to a food court; opens or resumes a 4-hour session |
| 2 | Browse | Open stalls, cuisine, typical wait | Derives availability from status, pause and kitchen heartbeat |
| 3 | Open a stall | Menu, sold-out items greyed **and labelled** | Loads menu; a basket holds one stall only |
| 4 | **Add to cart** | **Mobile number → OTP** | First and only auth prompt. Cart survives it |
| 5 | Add more | Running item total | No price is ever computed on the phone |
| 6 | Review | Item total, GST, platform fee, GST on fee, total | Server reprices from its own menu, returns every line |
| 7 | Pay | UPI | Order written with snapshotted terms and balanced ledger rows, one transaction |
| 8 | Track | Placed → Confirmed → Preparing → Ready | Client re-fetches authoritative state; socket events invalidate, never write |
| 9 | Collect | Order number, called at the stall | Kitchen marks collected |

### 11.2 Authentication

Mobile number + OTP, triggered at **add-to-cart**. Full reasoning in
[`docs/decisions/0001-customer-otp-at-add-to-cart.md`](./decisions/0001-customer-otp-at-add-to-cart.md).

Not at QR scan — that would gate browsing behind a form and lose everyone who was
merely curious. Not at checkout — that competes with the payment itself and adds
a second place to abandon a full basket. At add-to-cart the customer has
expressed intent and invested almost nothing.

Requirements:

- OTP hashed at rest, short-lived
- **Rate limited on send**, per number and per IP. An unauthenticated endpoint
  that sends paid SMS is one somebody will use to spend our money
- Attempt-limited on verify, to stop brute-forcing six digits
- **The cart must survive the auth flow.** Losing it is the most likely way to
  make this feel worse than no auth at all
- The session id does not change on authentication; `app_session.customer_id` is
  populated

> **Critical path consequence:** SMS OTP requires DLT registration in India, which
> is calendar-bound. No DLT → no OTP → no orders → no pilot. WhatsApp OTP avoids
> DLT but carries its own BSP approval lead time. See §15.

### 11.3 Cart

The cart holds `food_court_id`, `vendor_id`, and items. **One vendor per order**,
as an explicit system rule enforced server-side regardless of what the client
does.

Adding an item from a second stall prompts:

> Your cart contains items from Burger House. Start a new cart?
> `[ Cancel ]` `[ Clear Cart ]`

Never silently merged.

### 11.4 Order tracking

```
ORDER A27
  ✓ Order confirmed
  ✓ Vendor accepted
  ● Preparing
  ○ Ready
  ○ Collected
```

Live, without the customer refreshing. WebSocket or SSE. Socket events
**invalidate and trigger a re-fetch**; they never write client state directly,
because event ordering is not guaranteed and a client that derives state from
event sequence will eventually be wrong.

Sockets have landed and nothing had to be undone, exactly as this predicted:
the queries were already written to refetch on invalidation, so the socket
handler calls `invalidateQueries` and every screen behaves as it did on a timer.

What remains on a timer is a 60-second fallback in the customer app, 15 in the
kitchen and 30 on the console. That is not polling in the old sense; it is
cover for a socket that has died without saying so, which a client cannot
otherwise detect. `src/realtime/` sets out why that case is real.

### 11.5 Pickup

The order number is human-sayable and called at the stall. With an authenticated
customer, the order is tied to a known identity and the real proof lives in the
customer's own order screen — so no separate pickup token is needed. This closes
an open question from v6.1.

### 11.6 Order history

```
My Orders
  A27 · Burger House · ₹340 · Collected · Today 1:42 PM
```

Opening one shows items, payment, status timeline, vendor. Also the entry point
for refunds and support.

---

## 12. Vendor portal

### 12.1 Order management

| Column | Action |
| --- | --- |
| **New** | `ACCEPT` |
| **Preparing** | `MARK READY` |
| **Ready** | `MARK COLLECTED` |
| **Completed** | Historical |

Every ticket shows its age. Amber at two minutes, red at three — **and states the
number**, because food courts are lit badly and roughly 1 in 12 men has some
colour vision deficiency. Colour is never the only signal.

Rejection requires a reason, enforced by the database rather than the UI. "Why
did this stall reject forty orders" must have an answer.

### 12.2 Analytics

Vendor sees their own data only.

**Today:** orders received · completed · cancelled · pending · revenue

**Performance:** total orders · completed · cancelled · average preparation time ·
average order value · revenue · most ordered items · orders by hour · rejections

Terminology is load-bearing. Never show "Earned ₹12,480" without defining which
number that is. Use the financial vocabulary that actually exists:

```
Gross Order Value → Platform Fees → Refunds → Net Settlement
```

### 12.3 POS integration

A separate module under `Vendor → Integrations → POS`, not threaded through the
portal.

```
Integration Mode:  ○ Manual   ○ POS
POS: Connected 🟢   Last sync 13:42:21
  Menu: Synced · Inventory: Synced · Orders: Synced
```

**Deferred** — see §16.3.

---

## 13. Admin portal

Food-court scoped. Thirteen modules, per the §4 tree.

An earlier draft of this section described three — court setup, vendor approval,
QR management — and nothing operational or analytical. That version is gone. It
was small in the way that reads as discipline and behaves as a gap: three of the
cuts were load-bearing, and cutting them did not remove the work, it removed the
place the work was done. Force-refund became a SQL statement. A stuck order
escalated to a manager alert nobody could act on. Fee rules, which §14.1 insists
must change without a deploy, could only change with one.

**Sequencing is not the same as scope.** Everything below is V1. §20.1 puts none
of it in the pilot, where three to five stalls are onboarded by hand against the
§5.2 checklist and the operator can walk across the hall to a stuck order. What
follows is what the portal is, not what gets built first.

### 13.1 Setup and identity

**Food Court Management.** Create and edit a court · operating hours · branding ·
taxes and fees · ordering rules.

**QR Management.** Generate · activate · deactivate · reprint the court QR.
Deactivating a token must stop it resolving immediately, because a poster that
has left the building is the only way the venue credential leaks.

**Vendor Management.** Applications · approvals · active · suspended · inactive.
The approval surface: review a submitted vendor against the §5.2 gate, then
approve, reject, suspend, activate, deactivate or edit.

**User Management.** Platform and vendor staff accounts.

> **Vendor staff accounts are created and revoked by the platform, not by the
> vendor.** The account is a credential to a system that moves money on the
> vendor's behalf, so issuing it is the same kind of act as approval and belongs
> to the same people. It also keeps the audit trail honest: a departed cook is
> removed by someone with a reason to do it, rather than by whoever still knows
> the password.
>
> The cost is that adding a second cook is a support request. At pilot scale that
> is cheaper than a permissions UI nobody has asked for. Revisit when a court
> grows past a handful of stalls.

### 13.2 Operations

**Live Order Monitoring.** The court's board, and the ability to act on a stuck
one — force-cancel, force-dispatch, escalate. The escalation ladder (§11.4)
alerts a manager at 90 seconds; this is what that manager alert is *for*. Without
it the alert is a notification with no verb attached.

**Vendor Monitoring.** Per-stall acknowledgement latency, preparation time,
rejection rate, heartbeat freshness. The question it answers is "which stall is
about to become a problem", and it should answer it before a customer does.

**Audit & Activity.** Read-only view of `audit_log`. Append-only in the database,
so this is a window and never an editor.

### 13.3 Money

**Payments.** Per-order payment state, provider references, capture and
authorisation timestamps.

**Refunds.** Including manager force-refund (§14.7), which requires a reason and
is audited. This module exists specifically so that a refund is never an
untracked SQL statement — an unrecorded manual refund is exactly what the
append-only ledger was built to prevent, and moving refunds out of a UI does not
remove them, it removes the record.

**Settlements.** What each vendor is owed and was paid, stated in the vocabulary
of §12.2: Gross Order Value → Platform Fees → Refunds → Net Settlement. Reports
state which ledger authority they include (§14.2) — a figure that silently mixes
`AUTHORITATIVE` and `ADVISORY` rows is part measured and part inferred, with
nothing downstream able to tell which.

**Reconciliation.** The queue of items the payment engine opens when truth is
undeterminable (§7.2, §9). Never resolved automatically; a human closes each one
with a note.

### 13.4 Configuration and reporting

**System Configuration.** Fee rule administration (§14.3), court-level ordering
rules, escalation thresholds. §14.1 requires that the platform can change who
pays what, per court and per stall, **without a deploy**. That requirement is
only true if a surface exists — otherwise the mechanism is runtime-configurable
and the hands on it are engineering's.

**Analytics.** Court-level order volume, peak curves, per-stall performance,
abandonment. Aggregate for `COURT_OPERATOR`, who must never see another vendor's
commercial terms (RBAC-03).

## 14. Commercial model, money and tax

### 14.1 The founding constraint

The platform must be able to charge the vendor, or the customer, or both, or
neither — and change its mind per court and per stall **without a deploy**.

### 14.2 Two settlement modes

| | `PLATFORM_COLLECT` (A) | `VENDOR_DIRECT` (B) |
| --- | --- | --- |
| Who is paid | Platform collects; aggregator splits | Customer pays the vendor |
| Customer fee | Possible | Impossible — platform not in the flow |
| Commission | Deducted from the split | Invoiced afterwards |
| Ledger authority | `AUTHORITATIVE` | `ADVISORY` |
| Refunds | Platform initiates | Vendor must act |

The `authority` column is load-bearing. Mode B entries are the platform's belief
about money it never touched. Mixing them into one revenue figure produces a
number that is partly measured and partly inferred, with nothing downstream able
to tell which. **Reports must state which authority they include.**

### 14.3 Fee rules are data

Party · type · rate or amount · floor · optional cap · own GST rate · legal
settlement modes · version. Resolution is most-specific-wins: vendor beats food
court beats platform default.

Every order **snapshots the rules that priced it**, so changing the commission
next month does not move last week's settlement.

### 14.4 Worked example

₹250 food, 5% food GST, ₹5 customer fee, 3% commission, 1% operator share, 18%
GST on fees, Mode A, s.9(5) applying:

| Line | Amount |
| --- | ---: |
| Food | ₹250.00 |
| GST on food @5% | ₹12.50 |
| Platform fee | ₹5.00 |
| GST on fee @18% | ₹0.90 |
| **Customer pays** | **₹268.40** |
| Vendor net | ₹238.20 |
| Platform tax reserve | ₹12.50 |
| Vendor commission + GST | ₹8.85 |
| Operator share + GST | ₹2.95 |
| Retained fee + GST | ₹5.90 |
| **Total allocated** | **₹268.40** |

Verified by a property test across 500 generated orders, not by this example. The
example exists so a human can check arithmetic they can see; the property test
covers the orders nobody thought to write down.

### 14.5 Money

Every monetary value is an **integer count of paise** in a branded `Paise` type.
No floats, no decimals, no strings, anywhere in pricing, payments or the ledger.
Rounding is half-up, applied once, at defined points.

> This is not theoretical rigour. During development the driver returned every
> BIGINT as a string, because a script built its own connection pool and missed
> the type parser. `"18000" + "500"` concatenates to `18000500` — a ₹180,005
> charge on a ₹185 order, with no exception and no compile error. The branded
> type caught it.

### 14.6 The ledger

Double-entry, append-only, integer paise. Every order's entries sum to zero.
Corrections are new compensating entries; nothing is ever edited.

- **Enforced by trigger**, not grants. Triggers bind superusers; grants do not.
  `UPDATE`, `DELETE` and `TRUNCATE` are all refused
- **Balance asserted twice**, independently: in process before writing, and by a
  database view that must always return zero rows
- **Written in the same transaction as the order.** A ledger that can lag the
  order it describes is one that is sometimes wrong, and the window is exactly
  when a process dies mid-checkout
- **The tax reserve carries no party.** Attributed to the vendor it would settle
  out to them, and the platform would still owe a liability it had already paid
  away

### 14.7 Refunds

| Trigger | Amount | Initiated by |
| --- | --- | --- |
| Rejected before acknowledgement | Full | System |
| Rejected after acknowledgement | Full | System — vendor transfer may need clawing back |
| Partial item rejection | Partial | System — requires `PARTIALLY_REFUNDED` |
| Customer cancels before dispatch | Full | Customer |
| Dispatch unrecoverable | Full | System |
| Manager force-refund | Full or partial | Manager, audited, reason mandatory |
| Food never collected | **Undefined** | — no `ABANDONED` state exists yet |

A customer receives a refund **or** platform credit, never both — enforced by a
view that must stay empty, not by call ordering. In Mode B the platform cannot
initiate a refund at all; it records that one is owed and asks the vendor.

### 14.8 Tax — GST s.9(5)

> **The highest-stakes open decision in this document.**
>
> If s.9(5) applies, the platform is the e-commerce operator liable for GST on the
> restaurant service and must **retain** the food GST rather than settle it to the
> vendor.
>
> Wrong in the permissive direction, the platform overpays every vendor by ~5% of
> order value while earning ~3% commission — a loss on every order, compounding
> silently, discovered in reconciliation months later.
>
> **Owner: Finance plus an external chartered accountant.** Not an engineering
> decision, and engineering must not make it by default.

`TAX_SECTION_9_5_APPLIES` has **no default anywhere** and the application refuses
to boot without it. A boolean quietly defaulting to false is exactly how the
expensive version happens. It must not be defaulted to make a test pass; it is set
in the test instead.

---

## 15. Source of truth

When two systems disagree, this says which is believed.

| Fact | Authority | Everything else is |
| --- | --- | --- |
| Money moved | Payment provider | The ledger records our belief; disagreement is a reconciliation item |
| What was ordered | Platform order + snapshots | The stall's memory and the printed docket are copies |
| What it cost | The order's snapshotted terms | Current fee rules are irrelevant to a historical order |
| Kitchen has it | Acknowledgement event | Dispatch attempt only records that we sent it |
| Food collected | Vendor action | No sensor exists; a human assertion, trusted as one |
| Item availability | Vendor, as of last update | The customer view is derived and may briefly lag |
| Tax treatment | The order's tax model snapshot | A later determination does not rewrite history |

---

## 16. Non-functional requirements

### 16.1 Performance

| Measure | Target | Why |
| --- | --- | --- |
| Scan → vendor list | < 2s on 4G | Longer and the customer looks at the queue instead |
| Menu render | < 1.5s | Same, with less patience |
| Checkout price preview | < 800ms | Runs a full repricing; slower feels broken |
| Order placement | < 3s end to end | Includes the payment handoff |
| New ticket on the board | < 5s | Before the customer puts their phone away |
| Board refresh | 3s | A stale kitchen board is worse than a blank one — the cook believes it |

### 16.2 Accessibility

- Colour is never the only carrier of meaning
- Kitchen targets sized for gloved and wet hands
- Every interactive control has an accessible name
- Safe-area respected so the checkout bar clears the home indicator
- WCAG AA contrast on both the light customer theme and the dark kitchen theme

### 16.3 Security

- **The QR token is the venue credential.** The model is that holding it means
  being on the premises, so it must never be listed by any production endpoint
- Cross-tenant reads return **404, never 403**. A different status confirms the
  resource exists
- The token-signing seed has no default
- Inbound correlation ids are validated before reaching a log field
- **Rate limiting** on OTP send, QR resolution and every unauthenticated endpoint.
  Nothing is rate-limited today; this is a gap

### 16.4 Observability

- Every request carries a correlation id, echoed in the response header and
  present on every log line and ledger row it causes
- Liveness and readiness are separate endpoints. Wiring a database check into
  liveness turns a two-second blip into an outage
- Unexpected errors return an opaque 500 with a correlation id; the detail goes
  to the log
- Two invariant views must always return zero rows: ledger imbalance, and
  credit-refund conflict

---

## 17. How we know it works

§2.2 catalogued four guards that were present as text and absent as behaviour.
The rule that follows is the most transferable thing in this document.

> **For every constraint the specification claims, write the violation and assert
> that it fails.**
>
> Not "assert the rule is configured". Not "assert the string appears in the
> schema". Make something attempt the forbidden thing and check it is refused.
>
> Where setup is needed to make the violation meaningful, assert the setup
> succeeds too. An early version of the constraint suite ran an `INSERT` matching
> zero rows, threw nothing, and reported a false pass on every check.

| Layer | Establishes |
| --- | --- |
| Unit tests | Pure logic: pricing, state machine, permissions, escalation, readiness gate |
| Property tests | Invariants across generated inputs — the ledger balances for every order the pricing engine can price |
| Constraint tests | That the **database** refuses what the spec says it refuses. Each has a control that must succeed and a violation that must fail |
| Schema conformance | That the TypeScript types and the real database agree on every column, nullability, default and enum |
| Boundary tests | That module dependency rules are enforced, including a deliberately illegal import that must be reported |

### 17.1 Pilot exit criteria

Over two consecutive weeks at one court:

- Ledger imbalance view returns zero rows every day, without exception
- No customer charged for an order no stall accepted
- No vendor paid an amount they cannot reconcile against their own count
- Median scan-to-order under three minutes
- Stall acknowledgement within 45 seconds for 95% of orders
- **At least one stall asks to keep using it after the pilot ends**

The last is the only criterion that cannot be gamed by instrumentation, and the
one that decides whether a second court is worth signing.

---

## 18. Build state

| Area | State | Detail |
| --- | --- | --- |
| Money, pricing, tax | Working | Pure, property-tested; worked example reproduces in both tax branches |
| Database schema | Working | 33 tables, migrated from empty, constraint-verified on every push |
| Ledger | Working | Double-entry, balanced, append-only against all roles |
| Order placement | Working | One transaction, idempotent, snapshots terms, balanced ledger rows |
| Customer journey | Working | Scan → browse → menu → OTP → basket → priced checkout → payment → tracking |
| Staff login | Working | scrypt, per-user accounts, timing-equalised failures |
| Kitchen board | Working | Live tickets, accept, start, ready, collected, reject with reason |
| **Order vocabulary** | **Working** | `COLLECTED` and `PAYMENT_EXPIRED` landed; `COMPLETED` refused by CHECK |
| **Payment lifecycle** | **Working** | `AUTHORIZED`/`CAPTURED` split; intent, signed webhook, capture, expiry sweeper |
| **Product / availability / inventory** | **Working** | Three columns, daily stock, remaining computed from confirmed orders |
| **Customer OTP** | **Working, undeliverable** | Whole path built against a channel interface. Codes go to the log until DLT lands — see below |
| **Rate limiting** | **Working** | Postgres-backed fixed window on OTP send and verify |
| Payment aggregator | Stub only | Interface, webhook pipeline and capture all exercised; no provider chosen |
| **Dispatch worker** | **Working** | Exactly-once ticketing, `dispatch_attempt` rows, arms the ladder in the same transaction |
| **Escalation ladder** | **Working** | 15/45/90/180s running against `escalation_state`; blocks a stall at 90s, offers a refund at 180s |
| **Vendor heartbeat** | **Working** | Endpoint plus a 15s beat from the board; availability derived from freshness |
| **Notifications** | **Working, undeliverable** | Tier ladder runs and dedupes; every tier is unavailable in development and records why |
| **Platform console — courts and stalls** | **Working** | Create a court, create stalls under it, onboard against the §5.2 gate, activate. Server-enforced, audited |
| **Vendor activation gate** | **Working** | No longer library-only. Wired to endpoints and a live checklist; evaluated inside the activation transaction against a locked row |
| Platform console — the rest | Not built | QR issue/revoke, staff logins, live orders, money. See below |
| Settlement, reconciliation | Not built | Schema exists, no reports |

**On §13 and the console that was actually built.** §13 specifies thirteen
modules for a world with a court operator taking a revenue share and a floor
manager acting on stuck orders. Migration `20260818000010_two_party_split`
removed the first — the platform is sold direct to vendors, `fee_rule` now
refuses `party = 'OPERATOR'` by CHECK — and there is no manager because nobody
from the platform is in the building.

So the console is **not court-scoped and has no approval queue**: vendors do not
apply, they are onboarded by whoever sold to them. What is built is the spine —
courts, stalls, and the §5.2 gate between onboarding and taking money.

Three gaps are worth naming precisely, because each one is currently a SQL
statement somebody has to write:

- **QR issue and revoke.** A court is created with no token, so it cannot be
  entered. Only `seed:dev` issues one. §13.1 calls deactivation the only defence
  when a poster leaves the building.
- **Staff logins.** `NO_STAFF_ACCOUNT` is a blocker the console shows and cannot
  clear, so every stall needs an insert before its kitchen board works.
- **Menu.** Cleared by the CSV import endpoint, which has no screen.

**One login, three roles.** `SUPER_ADMIN` holds one permission — `tenant.manage`
— so it can create a court and not a stall. The console account also holds
`PLATFORM_OPS` and `PLATFORM_FINANCE`; `user_role_assignment` and the token's
`rol` claim are both plural precisely for this. The person sees one console; the
audit log can still say which hat an action was taken under.

> **The gap named here in v7.0 is closed.** An order now moves
> `CREATED → PAYMENT_PENDING → PAYMENT_CONFIRMED → … → COLLECTED` end to end.
> The customer journey and the kitchen board are joined.

Two things are worth stating precisely, because "working" is doing different
work in two rows above.

**Payment works; no aggregator is chosen.** The engine runs against the stub
provider, which refuses to construct in production. Everything downstream of
the signature check — claim, decide, apply, capture, expire — is production
code and is exercised on every local order. Choosing Razorpay Route or another
aggregator is one adapter against `PaymentProvider`, not a rewrite. §19 row 2
is still open and this does not close it.

**OTP works; no code reaches a phone.** Generation, keyed hashing, attempt
limiting, rate limiting, the customer token and the session attachment are all
built and tested. The `console` channel prints the code to the API log and
refuses to run in production; the `sms` channel throws at boot with the reason.
That is deliberate — an empty implementation returning success would tell every
customer a code had been sent, deliver none, and show a clean success rate in
the logs. **DLT registration remains the single blocker on taking a real
order**, exactly as §19 row 1 says, and nothing here has moved that date.

**Notifications run; nothing is delivered.** The same shape, for the same
reason. The ladder walks WEBSOCKET → WEB_PUSH → WHATSAPP → SMS, and today every
rung reports `SKIPPED` with a stated reason — no socket layer, no VAPID keys,
no BSP, no DLT — before a console channel logs what would have been sent.

The rows are the point. A tier that is unavailable writes a `SKIPPED` row rather
than being omitted, so "the customer was never told" is a fact in the table
instead of an absence indistinguishable from an event that never happened. When
the ladder runs out entirely, that logs at error level with the message nobody
received: someone is sitting at a table waiting for food that is on the counter.

**On workers and queues.** `docs/tech/infrastructure.md` names BullMQ, which
needs Redis, and no Redis client is installed. The sweeps are Postgres
`FOR UPDATE SKIP LOCKED` loops instead — correct across replicas today rather
than correct once Redis arrives, and idempotent by construction because a poll
can always run twice. The cost is granularity: a rung fires within one 5-second
tick of its due time rather than exactly on it, which against a 15-second first
rung is a rounding error. When Redis lands these become the safety net that
catches what the queue drops, not the thing deleted first.

---

## 19. Open decisions

| # | Decision | Owner | Blocks |
| --- | --- | --- | --- |
| 1 | **DLT registration / OTP channel** | Founder | **Orders entirely.** Calendar-bound — start now |
| 2 | **Payment aggregator** | Founder + Finance | Order confirmation, settlement, refunds, Mode A activation |
| 3 | **GST s.9(5) determination** | Finance + external CA | Correct settlement. Wrong answer loses money on every order |
| 4 | Ledger catalogue for discounts and credit | Product + Finance | Any promotion. Currently refused rather than guessed |
| 5 | `ABANDONED` state for uncollected food | Product | Nothing yet; will surface in week one of the pilot |
| 6 | **Stale companion documents** | Engineering | See §19.4. The API contract and the TDD describe an architecture this document has replaced |

### 19.4 Documentation blockers

Three artifacts still describe the table-level QR model this document replaced in
§2.1. They are not merely out of date — they are **actively contradictory**, and
each is the document somebody would reasonably build from.

| Artifact | Contradiction | Who it misleads |
| --- | --- | --- |
| `contracts/openapi.yaml` | `/qr/{token}` still returns a `table` object; no session or OTP endpoints | Anyone generating a client, and the `codegen:api` script |
| Technical Design Document v1 | Table-level QR throughout; ledger described as GRANT-enforced | Anyone building the admin portal or the settlement reports |
| Interface Specifications v1 | QR print asset specified per table | Whoever prints the pilot signage — **this one produces physical waste** |

The rule that applies is the same one in §17: a specification that says one thing
while the system does another is a check whose failure mode is silence. Nobody is
warned; they simply build the wrong thing and find out later.

**Position:** these are blockers on *starting new surface*, not on the pilot. The
customer PWA and kitchen board were built from this document and are correct. But
the admin portal, the settlement reports and the printed signage would all be
built from the stale copies, and two of those are expensive to redo.

Minimum to clear: regenerate `openapi.yaml` from the endpoints that actually
exist, and mark the two `.docx` files superseded in their own headers rather than
only in this document's footer — a reader who opens the TDD directly currently
gets no warning at all.

**Partly done, 17 August 2026.** `contracts/openapi.yaml` now carries the
warning in its own `info.description`, with a table of every known divergence
and a note that `npm run codegen:api` currently produces types contradicting
the server. That is the cheap half — it stops somebody being misled — and it is
not the fix. The file still describes the old model and the version string now
reads `1.0.0-pilot-STALE` so nothing can quietly depend on it.

Regeneration got further away rather than closer today: this build added the
OTP, payment and inventory endpoints and renamed `/complete` to `/collect`. The
two `.docx` files remain unmarked, and the Interface Specifications one is
still the document somebody would print pilot signage from.

### 19.1 Aggregator selection criteria

| Criterion | Why it decides |
| --- | --- |
| Split settlement to sub-merchants | Mode A is unimplementable without it |
| Sub-merchant onboarding and KYC API | Otherwise every stall is a manual back-office task |
| Webhook reliability and replay | The pipeline is idempotent, but a provider that never retries loses orders |
| Refund API with partial support | Rejection after acknowledgement requires it |
| UPI single-block-multi-debit | Not required for pilot; the correct long-term primitive |
| Settlement timing and fees | Directly sets the commission floor |

### 19.2 Long-lead items

- **DLT registration** (blocking — see §11.2)
- WhatsApp BSP selection and template approval
- Pilot food court signed, operator revenue share agreed
- Menu digitisation for pilot stalls — the most underestimated task in the plan
- Kitchen tablet hardware, mounting, wi-fi survey
- Vendor agreement, customer terms, privacy policy

### 19.3 Deferred, with reasoning

**POS integration contract.** No POS is chosen and none is in pilot scope. A
contract written against an unchosen vendor is fiction that would later have to be
unwritten — the same failure as the ledger discount catalogue. The internal
normalised model (§6.2) is specified now; `external_item_id` already exists as the
seam. The adapter waits for a POS.

---

## 20. Scope

### 20.1 Pilot (P0)

One food court, three to five stalls · court-level QR · customer PWA with OTP ·
kitchen board · one settlement mode · manual vendor onboarding using the
readiness gate as a checklist.

### 20.2 V1

Both settlement modes · admin portal including self-service onboarding ·
settlement reports and reconciliation · full notification ladder · escalation
worker and heartbeat · inventory tracking · menu import from CSV.

### 20.3 Out of scope

Delivery · table service · loyalty and promotions (the ledger cannot represent
them — see §19) · multi-court browsing · cash orders.

---

## 21. Risks

| Risk | Severity | Position |
| --- | --- | --- |
| DLT registration delayed | **Critical** | No orders at all. Calendar-bound; cannot be recovered by adding people |
| GST s.9(5) decided wrongly | Critical | Loss on every order, compounding, discovered late. Mitigated by refusing to boot without an explicit determination |
| Aggregator cannot split to sub-merchants | Critical | Mode A unimplementable. Mitigated by the provider interface |
| Stalls ignore the tablet | High | The escalation ladder exists for this. Constant firing at one stall means that stall is not ready |
| Menu digitisation stalls the pilot | High | Consistently underestimated. Needs a named owner and a start date |
| OTP friction reduces conversion | Medium | Placed at add-to-cart to minimise it. Measure abandonment at that step specifically |
| iOS notification limits | Medium | Web Push needs a home-screen install. WhatsApp is the answer, with weeks of lead time |
| Court wi-fi unreliable | Medium | Ordering requires connectivity by design — an order queued on a phone is one nobody is cooking |
| Vendor disputes a settlement | Medium | The append-only ledger is the answer |

---

## 22. Glossary

| Term | Meaning |
| --- | --- |
| Court | The venue. One QR identity, many stalls, shared seating |
| Stall / vendor | One kitchen with its own menu, terms and settlement account |
| Operator | The business running the venue, usually taking a revenue share |
| Mode A / `PLATFORM_COLLECT` | Platform collects; aggregator splits to the vendor |
| Mode B / `VENDOR_DIRECT` | Customer pays the vendor; platform observes but holds no funds |
| Paise | One hundredth of a rupee. The only unit money is stored in |
| Authority | Whether a ledger entry records observed money (authoritative) or reported money (advisory) |
| Tax reserve | Food GST retained under s.9(5). Never the vendor's money |
| Product status | Whether an item exists on the menu — §6 |
| Availability | Whether it can be ordered right now — §6 |
| Inventory | How many remain today — §6 |
| Escalation ladder | 15/45/90/180 seconds when a stall does not acknowledge |
| Acknowledgement | A machine-verifiable signal the kitchen has the ticket — not a courtesy tap |
| Idempotency key | A client-generated identifier, constant across retries, making resubmission safe |
| Correlation id | One identifier threading a customer action through every log line and ledger row it caused |
| DLT | Distributed Ledger Technology — India's mandatory registration for transactional SMS |

---

## Companion documents

| Document | Covers |
| --- | --- |
| [`docs/errata.md`](./errata.md) | The seven corrections in full, with reasoning and the regression guard for each |
| [`docs/decisions/`](./decisions/) | Decision records. DR-0001: customer OTP |
| [`tech.md`](../tech.md) | Technology choices and rejected alternatives |
| [`docs/tech/`](./tech/) | Per-layer technology decisions |
| `contracts/openapi.yaml` | The wire contract — **stale, still returns a table object from `/qr/{token}`** |
| Technical Design Document v1 (.docx) | Module decomposition, pricing algorithm, ledger worked entries — **stale on the QR model** |
| Interface Specifications v1 (.docx) | Auth lifecycle, thermal docket, menu CSV, QR asset — **stale on the QR model** |
