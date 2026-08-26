# Food Court QR Ordering Platform

Tapvera Technologies Pvt Ltd

A customer sits at a food-court table, scans the QR code on it, browses every
stall in the court, orders from one, pays by UPI, and is told when to collect.
No app install, no login, no queue.

**Status: the customer journey runs end to end** — scan, browse, verify,
order, pay, cook, collect. Against a payment stub and with no SMS delivery;
both are external decisions, not unwritten code. See [RUNBOOK.md](./RUNBOOK.md)
to run it and [docs/prd.md](./docs/prd.md) §18 for exactly what is and is not
built.

---

## Quick start

```bash
npm install
npm run setup         # migrate + seed a court, three stalls, menus, logins
npm run dev:all       # api + worker + pwa + kds in one terminal, Ctrl-C stops all
```

Then **http://localhost:5173** as a customer, **http://localhost:5174** as the
kitchen. The full walkthrough — including where to find the OTP, since no SMS
is sent — is in **[RUNBOOK.md](./RUNBOOK.md)**.

```bash
npm run verify:db     # migrates from empty and proves every constraint
npm test              # unit + property + integration
```

```bash
curl localhost:3000/healthz   # liveness  — 200 if the process is alive
curl localhost:3000/readyz    # readiness — 200 only if it can actually serve
```

`verify:db` does **not** require Docker. It reads `DATABASE_URL` from `.env`,
and if something already answers there — Homebrew, Postgres.app, a cloud
instance — it uses it and never touches Docker. Docker is one way to obtain a
Postgres, not the point of the exercise. If nothing answers, run
`npm run db:doctor`, which diagnoses the usual cause: two Postgres installs
fighting over port 5432, where the Homebrew one binds `127.0.0.1` and wins
while the container binds `*` and loses, so `docker ps` looks healthy and
nothing can connect.

The escape hatch is `POSTGRES_PORT` in `.env` — compose reads the same file, so
setting it to 5433 moves the container out of the way and updates nothing else.
`.env` ships pointing there, because this checkout has a Homebrew Postgres on
5432. See [RUNBOOK.md](./RUNBOOK.md) for both paths.

### Walking the whole journey locally

`npm run dev:all` starts four processes. The **worker is not optional** —
without it a paid order stays in `PAYMENT_CONFIRMED` and never reaches a
kitchen board, nothing watches for a stall that has gone quiet, and nobody is
told their food is ready.

Full detail in [RUNBOOK.md](./RUNBOOK.md). The short version, as a customer at
**http://localhost:5173**:

1. Pick a court on the dev entry screen — it stands in for scanning the poster.
2. Choose a stall, open the menu, tap **ADD**.
3. You are asked for a mobile number. **No SMS is sent** — the code is printed
   in the API terminal as `otp_console_delivery`. Real delivery needs DLT
   registration, which is still outstanding and is the only thing standing
   between this and a real order.
4. The item is still in your basket. That is deliberate and it is the property
   most likely to break; if it ever does not survive, that is a bug.
5. Review, pay. There is no aggregator, so the payment screen offers
   **Simulate a successful payment** — which asks the server to forge a
   stub-provider webhook and run it through the real verification path. The
   client never confirms anything; it polls until the server has heard.
6. Watch the order move on the kitchen board.
7. Mark it **Ready** and check the API terminal: `notification_console_delivery`
   is the message the customer would have received.

To watch the escalation ladder, accept nothing. At 15 and 45 seconds the worker
redispatches, at 90 the stall is blocked from new orders and the board says so,
at 180 the order fails and the customer is offered a one-tap refund. Shorten
`DISPATCH_LADDER_STEP*_SECONDS` in `.env` if you would rather not wait.

As the kitchen, open **http://localhost:5174** and sign in with a stall login
printed by `seed:dev`. Accept → Start → Ready → Hand over.

To reset and go again: `npm run reset:orders`, then `npm run seed:orders` if
you want a pre-populated board.

### What actually runs today

| Works now | Not built yet |
| --- | --- |
| Scan → browse → OTP → basket → priced checkout → payment → kitchen → collected | Admin portal — 13 modules, PRD §13, all V1 |
| Double-entry ledger, append-only against every role including TRUNCATE | Settlement and reconciliation reports |
| Payment lifecycle: intent, signed webhook, authorise, capture, expiry sweep | A real aggregator adapter |
| Dispatch worker, escalation ladder, vendor heartbeat | Vendor onboarding endpoints (pilot onboards by hand) |
| Notification ladder with per-tier dedupe | Redis-backed queues — the sweeps are Postgres SKIP LOCKED |
| Product / availability / inventory as three concepts, remaining computed | Server-side cart, order history |
| Rate limiting on OTP send and verify | POS integration (deferred, PRD §19.3) |

Three honest caveats about that left-hand column:

- **The payment engine works; no aggregator is chosen.** It runs against a stub
  that *refuses to construct in production*, because a stub there confirms
  payments nobody made. Everything after the signature check is production code.
- **OTP works; no code reaches a phone.** The `console` channel prints to the
  log and refuses production; the `sms` channel throws at boot with the reason,
  rather than silently telling every customer a code was sent.
- **Notifications run; nothing is delivered.** Same shape. Every rung of the
  ladder reports `SKIPPED` with a stated reason and writes a row for it, so
  "nobody was told" is a fact in the table rather than an absence.

---

## The three rules

If you read nothing else before writing code here:

1. **Money is `Paise`, an integer branded type.** No floats, no decimals, no
   strings — in `pricing`, `payments` or `ledger`, ever. `src/platform/money.ts`.

2. **Order status is never assigned.** It changes only through a guarded command
   that takes a row lock, validates against the transition allow-list, and
   appends to `order_status_history` in the same transaction.

3. **`TAX_SECTION_9_5_APPLIES` has no default and the app refuses to boot
   without it.** If GST s.9(5) applies, the platform must retain the food GST
   rather than settle it to the vendor. A boolean defaulting to `false` is how a
   platform overpays every vendor by ~5% of order value against a ~3%
   commission. Do not add a default to make a test pass — set it in the test.

---

## Layout

```
src/platform/     money · errors · config · correlation · logger · db · audit  (leaf)
src/identity/     permissions matrix · rbac · tokens
src/tenancy/      qr tokens · sessions
src/catalog/      option group rules · derived availability
src/cart/         cart with the single-vendor invariant
src/pricing/      fee engine · tax model · computeQuote          (PURE — no I/O)
src/ordering/     order state machine and command catalogue
src/payments/     provider interface · stub · webhooks · credit · refunds
src/dispatch/     escalation ladder
src/health/       liveness, readiness, metrics
db/migrations/    plain SQL. 20260810000001_init.sql is the whole schema.
contracts/        openapi.yaml — the authoritative wire contract
docs/tech/        technology decisions, per layer
tests/property/   fast-check invariants
tests/integration/
```

Module dependency direction is defined in Technical Design Document §2.1 and
**enforced** by `eslint-plugin-boundaries` in `eslint.config.js`.
`tests/integration/boundaries.test.ts` proves the enforcement is live — it was
silently doing nothing at first, and a boundary rule that fails open is worse
than none at all.

---

## Commands

| Command                           | Does                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `npm run setup`                   | Migrate, then seed a court, stalls, menus and logins   |
| `npm run dev:all`                 | API + worker + PWA + KDS. Ctrl-C stops all four        |
| `npm run dev`                     | API with reload                                        |
| `npm run dev:worker`              | Dispatch, escalation, notifications, payment expiry    |
| `npm run reset:orders`            | Clear orders, keep court and menus                     |
| `npm run typecheck`               | `tsc --noEmit`, strict                                 |
| `npm run lint`                    | ESLint incl. module boundaries. Zero warnings allowed. |
| `npm test`                        | Unit + property + integration                          |
| `npm run verify:db`               | Migrate from empty, then assert every §18.3 constraint |
| `npm run test:constraints`        | Asserts PRD §18.3 rules fail at the **database**       |
| `npm run db:doctor`               | Diagnoses "container is up but nothing connects"       |
| `npm run check:req-ids`           | Every requirement ID cited in code exists              |
| `npm run build`                   | `tsc` to `dist/`                                       |
| `bash scripts/verify-shutdown.sh` | Proves SIGTERM drains cleanly                          |

---

## Specification

The docx set is the signed-off archive; the markdown in this repo is what you
read day to day.

| Document                              | Covers                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| [`docs/prd.md`](docs/prd.md) **v7.0**  | The source of truth. §18 is what is and is not built                    |
| [`RUNBOOK.md`](RUNBOOK.md)             | Running it, resetting it, and what each failure means                  |
| [`docs/errata.md`](docs/errata.md)     | Eight defects found by executing the system, and the guard added for each |
| [`docs/decisions/`](docs/decisions/)   | Decision records. DR-0001: customer OTP at add-to-cart                  |
| [`tech.md`](tech.md)                   | Technology choices and rejected alternatives                           |
| `contracts/openapi.yaml`               | **Stale.** Warns in its own header; see PRD §19.4                      |
| Technical Design Document v1 (.docx)   | **Stale on the QR model, payment states and availability**             |
| Interface Specifications v1 (.docx)    | **Stale.** Specifies a per-table QR print asset that no longer exists  |

---

## Three decisions that are still open

None of them is code. Two are calendar-bound, which means engineering cannot
accelerate them by starting earlier on something else.

1. **DLT registration.** India requires the sender entity, header and every
   template to be registered before transactional SMS is delivered. Customer
   OTP gates order placement, so **this blocks taking a single real order.**
   Owner: founder. Start first.
2. **Payment aggregator.** Razorpay Route is the working assumption, pending
   the criteria in PRD §19.1. Blocks settlement, refunds and Mode A.
3. **The GST s.9(5) determination.** Owner: Finance plus an external CA. Until
   it lands `TAX_SECTION_9_5_APPLIES` is a guess, and getting it wrong in the
   permissive direction loses roughly 2% of every order, silently, discovered
   in reconciliation months later.
# Foodie
