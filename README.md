# Food Court QR Ordering Platform

Tapvera Technologies Pvt Ltd

A customer sits at a food-court table, scans the QR code on it, browses every
stall in the court, orders from one, pays by UPI, and is told when to collect.
No app install, no login, no queue.

**Status: Weeks 1–4 complete; weeks 5–7 partially built against the payment stub.** Pilot release P0 targets one food court.

| Week | Scope                                                                | Gate                                                                    | State                                |
| ---- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| 1    | Foundations — money, config, errors, correlation, logging, migration | Migration runs clean; app refuses to boot without a tax determination   | Done                                 |
| 2    | Identity, RBAC, tenancy, QR tokens, audit                            | A deliberate cross-tenant read returns 404 and is logged                | Done                                 |
| 3    | Catalog, cart, session                                               | A cart cannot hold two vendors, even via direct API calls               | Done                                 |
| 4    | Pricing — fee engine, tax model, rounding                            | The TDD §4.2 worked example reproduces to the paisa in both tax columns | Done                                 |
| 5    | Payments — provider interface, stub, webhook pipeline, state machine | Duplicate and delayed webhooks produce exactly one order                | Logic done; adapter blocked on §31.1 |
| 6    | Refunds — credit/refund mutual exclusion, retry schedule             | A customer can never both spend credit and receive the refund           | Logic done                           |
| 7    | Dispatch — escalation ladder                                         | Every scenario in TDD §17.1 passes                                      | Ladder done; needs a DB and worker   |

---

## Quick start

```bash
npm install
npm run verify:db     # finds a Postgres, migrates from empty, proves the constraints
npm test              # unit + property + integration
npm run dev           # API on :3000
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

### What actually runs today

Being precise about this, because the table above says "weeks 1–7" and that
could be read as a working product:

| Works now                                              | Not built yet                        |
| ------------------------------------------------------ | ------------------------------------ |
| `/healthz`, `/readyz`, `/metrics`                      | Any ordering endpoint                |
| The full schema, migrated and constraint-verified      | Repositories and the order service   |
| Pricing, cart, RBAC, state machine, escalation — as libraries with tests | Anything that writes to the database |
| The payment **stub**                                   | A real aggregator adapter (§31.1)    |
|                                                        | The customer PWA, KDS, consoles      |

So `npm run dev` gives you a health endpoint, not a food court. The domain
logic is real and tested; nothing has been wired to HTTP or to persistence yet.
That is the next block of work.

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
| `npm run dev`                     | API with reload                                        |
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

| Document                         | Covers                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| PRD v5.2                         | 220 requirements, commercial and regulatory architecture, scope, economics                  |
| Technical Design Document v1.0   | Module decomposition, pricing and tax algorithm, credit/refund exclusion, escalation ladder |
| Interface Specifications v1.0    | Auth token lifecycle, thermal docket, menu import CSV, QR print asset                       |
| Infrastructure & Operations v1.0 | Topology, alert thresholds, runbooks                                                        |
| [`tech.md`](tech.md)             | Technology choices and rejected alternatives                                                |

---

## Two decisions that are still open

Neither blocks weeks 1–4. Both block week 5.

1. **Payment aggregator.** Default assumption is Razorpay Route, pending
   verification against the criteria in PRD §4.6.
2. **The GST s.9(5) determination.** Owner: Finance plus an external CA. Until
   it lands, `TAX_SECTION_9_5_APPLIES` is a guess — and the pricing and split
   logic cannot be written correctly on a guess.
