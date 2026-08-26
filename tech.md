# Technology Stack

**Food Court QR Ordering Platform · Tapvera Technologies Pvt Ltd**
Version 2.0 · 19 August 2026 · Status: **as built**. Supersedes v1.0.

v1.0 was written before the code and described what we intended to use. Eight of
its choices did not survive contact with the build, and it went on describing
them for two months — Redis, BullMQ, Argon2, Playwright, `date-fns`, all named as
current and none installed. A stack document that lists dependencies nobody
installed is worse than no document: it is the thing a new engineer trusts.

**This version describes what is in `package.json` and what the code does.**
Every claim here is checkable in about ten seconds, and §8 lists what was
proposed and dropped so nobody re-adds it by reading the old file.

| Layer             | Detail                                                       |
| ----------------- | ------------------------------------------------------------ |
| Frontend          | [`docs/tech/frontend.md`](docs/tech/frontend.md)             |
| Backend           | [`docs/tech/backend.md`](docs/tech/backend.md)               |
| Data              | [`docs/tech/data.md`](docs/tech/data.md)                     |
| Integrations      | [`docs/tech/integrations.md`](docs/tech/integrations.md)     |
| Infrastructure    | [`docs/tech/infrastructure.md`](docs/tech/infrastructure.md) |
| Tooling & testing | [`docs/tech/tooling.md`](docs/tech/tooling.md)               |

> **The six files above are from the v1.0 era and are partly stale.** PRD §19.4
> tracks this. `infrastructure.md` in particular still names BullMQ and Redis.
> Where they and this file disagree, **this file is right** — it was written
> against the code.

---

## 1. The five principles behind every choice

Read these before arguing about a library. Most disagreements resolve here.

1. **Correctness over throughput.** The load model is ~8 orders per minute at
   burst, per court. This system will never fall over from traffic. It will fall
   over from a duplicated webhook or a refund that stopped retrying. Every time
   performance and provability conflict, pick provable.

2. **The database enforces the rules, not the application.** Unique constraints,
   partial indexes, foreign keys, row locks, and **triggers** on the append-only
   tables. A tool that makes those awkward to express is the wrong tool, however
   pleasant its API.

3. **Boring, widely-known technology.** A small team has to hire for this and
   debug it at 1pm on a Saturday. Novelty is a cost.

4. **One deployable until scale says otherwise.** Modular monolith, hard internal
   boundaries, API and worker from one image. No service mesh, no Kubernetes, no
   event bus, until a real constraint demands it.

5. **A guard that cannot be seen failing is not a guard.** Four of the seven
   defects in PRD §2 were checks that silently did nothing — a `REVOKE` against a
   role that did not exist, a lint rule that resolved no imports, a `DELETE`
   trigger that `TRUNCATE` bypasses. Every protective mechanism in this repo has
   a test that proves it can refuse.

---

## 2. Stack at a glance

Everything in this table is installed and used. Versions are the `package.json`
range, not the lockfile pin.

### Backend — root `package.json`

| Concern       | Choice                | Version | Notes                                                            |
| ------------- | --------------------- | ------- | ---------------------------------------------------------------- |
| Language      | TypeScript            | 5.6+    | `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` |
| Runtime       | Node.js               | 22.9+   | Matches the `Dockerfile`                                          |
| Framework     | NestJS                | 11      | For enforceable module boundaries                                 |
| HTTP adapter  | Express               | 5       | Via `@nestjs/platform-express`                                    |
| Database      | PostgreSQL            | 16      | Transactional core, ledger, job sweeps and rate limits            |
| Query layer   | Kysely                | 0.27+   | Typed SQL builder. **Not an ORM** — see §8                        |
| Driver        | `pg`                  | 8       |                                                                   |
| Validation    | Zod                   | 3       | At every HTTP boundary                                            |
| Auth          | `jose`                | 6       | EdDSA JWTs, four token types                                      |
| Passwords     | `node:crypto` scrypt  | stdlib  | **Not Argon2** — see §8                                           |
| Logging       | Pino                  | 9       | Structured JSON, allow-list redaction                             |
| Metrics       | `prom-client`         | 15      | `/metrics`                                                        |
| Hashing (OTP) | `@noble/hashes`       | —       | HMAC-SHA-256 under a pepper                                       |

### Frontends — three separate Vite apps

| App                | Path         | Port | Theme default | Audience                     |
| ------------------ | ------------ | ---- | ------------- | ---------------------------- |
| Customer PWA       | `apps/pwa`   | 5173 | light         | A phone, in daylight         |
| Kitchen board      | `apps/kds`   | 5174 | dark          | A mounted tablet over a range |
| Platform console   | `apps/admin` | 5175 | light         | A laptop, at a desk          |

All three share: React 19, Vite 6, TanStack Query 5, React Router 7, Tailwind 4.
`apps/pwa` and `apps/kds` also use Zustand 5 — cart and session only, nothing
that belongs to the server. `apps/admin` has no client state library at all,
because every screen in it is server state.

### Tooling

| Concern       | Choice                     | Notes                                              |
| ------------- | -------------------------- | -------------------------------------------------- |
| Tests         | Vitest                     | Unit, property, integration                        |
| Property tests| `fast-check` 3             | **Mandatory** for pricing and ledger               |
| Boundaries    | `eslint-plugin-boundaries` | Module dependency direction, enforced not suggested |
| API types     | `openapi-typescript` 7     | Generates from `contracts/openapi.yaml`             |
| Coverage      | `@vitest/coverage-v8`      |                                                     |
| Formatting    | Prettier                   |                                                     |
| Dev runner    | `tsx`                      | `--watch`, no build step in development             |

---

## 3. What replaced the queue, the cache and the socket layer

The three most consequential departures from v1.0, together, because they are
one decision: **Postgres does all of it, for now.**

### Jobs — `FOR UPDATE SKIP LOCKED`, not BullMQ

`src/workers/index.ts` is a 1.5-second poll loop. Each sweep claims rows with
`FOR UPDATE SKIP LOCKED`, which is correct across replicas today rather than
correct once Redis arrives, and idempotent by construction because a poll can
always run twice.

The cost is granularity: a rung fires within one tick of its due time rather
than exactly on it. Against a 15-second first escalation rung that is a rounding
error. `TICK_MS = 1500` is not arbitrary — worker tick plus the board's 3-second
poll must stay inside PRD §16.1's 5-second budget from payment to ticket.

**When Redis lands, these become the safety net that catches what the queue
drops — not the first thing deleted.**

### Rate limiting — a Postgres table, not Redis

`rate_limit_counter`, a fixed window. `src/platform/rate-limit.ts` says why in
its own header: "use Redis" today would mean writing a `Map` and calling it
Redis.

### Realtime — nothing, yet

`socket.io` and `socket.io-client` **are in `package.json` and nothing imports
them.** Zero files. They were installed ahead of a socket layer that was never
built.

Everything is polling, at rates chosen per surface:

| Surface                     | Interval | Why that number                                        |
| --------------------------- | -------- | ------------------------------------------------------ |
| Kitchen board — orders      | 3s       | A ticket must appear before the customer pockets the phone |
| Customer — order tracking   | 4s       | Stops on a terminal state                              |
| Device heartbeat            | 15s      | 3 missed beats before a stall drops off the customer list |
| Kitchen board — menu        | 15s      | Nobody watches this for updates                        |
| Kitchen board — stall status| 10s      | A pause expires on its own; the countdown must be honest |
| Platform console            | none     | Only changes because the person using it changed something |

---

## 4. Data

### Money

**Integer paise, everywhere.** No floats, no decimals, no strings in `pricing`,
`payments` or `ledger`. Rupees exist only in form inputs and are converted once,
server-side, with `Math.round` on a schema-bounded value.

### The ledger

Double-entry, balanced, **append-only by database TRIGGER**. Errata E-002: the
original claim was `REVOKE`, which does not bind a superuser and therefore
protected nothing. Triggers do.

Five tables refuse `UPDATE` and `DELETE`:

`ledger_entry` · `order_status_history` · `audit_log` · `processed_event` ·
`dispatch_attempt`

`TRUNCATE` is blocked by a **separate** trigger event (errata E-008) — a `DELETE`
guard misses it silently, which is exactly the §2.2 failure pattern.

Corrections are new compensating entries. Nothing is ever edited.

### Schema

36 tables, 23 migrations, applied from empty on every push and constraint-verified
by `npm run test:constraints`.

Migrations are plain `.sql` run by `scripts/migrate.ts` — about 60 lines over
`pg`. Two Postgres-specific lessons are encoded in the file layout:

- **Enum additions get their own migration.** `ALTER TYPE ... ADD VALUE` cannot
  be *used* in the transaction that added it.
- **Order matters within a migration.** Delete the rows a constraint forbids,
  *then* add the constraint. The reverse works on an empty database and fails on
  every database that has ever been seeded.

### Time

`Intl.DateTimeFormat`, not a date library. `src/catalog/service-date.ts` derives
a court-local service day with a cached formatter. `date-fns` was proposed and
never needed.

---

## 5. Identity

Four token types, one issuer (`src/identity/tokens.ts`):

| Type       | Holder                | Obtained by                     |
| ---------- | --------------------- | ------------------------------- |
| `session`  | An anonymous browser  | Scanning the court QR           |
| `customer` | A verified phone      | OTP verify                      |
| `staff`    | A person              | Email + password                |
| `device`   | A tablet              | Pairing code                    |

**Authorisation is separate from authentication, and that split is load-bearing.**
A guard proves *who*; `decide()` in `src/identity/rbac.ts` decides *what they
may do*. A guard that also authorises comes to mean "signed in", and then
everyone signed in gets everything.

**31 permissions × 9 roles** in one matrix (`src/identity/permissions.ts`).
`tests/conformance/console-authz.mjs` asserts every console handler calls
`decide` — and contains a negative control that sabotages a controller in memory
to prove the check can fail.

**One account can hold several roles.** `user_role_assignment` and the token's
`rol` claim are both plural for this. The platform console account holds
`SUPER_ADMIN` + `PLATFORM_OPS` + `PLATFORM_FINANCE`: one login, and an audit log
that can still say which hat an action was taken under.

`SUPER_ADMIN` holds exactly **one** of the 31 permissions — `tenant.manage`.
That looks like an oversight and is not: a super admin can create tenants and
cannot silently reprice a menu or move money.

**Two roles in the matrix are now unreachable.** `COURT_OPERATOR` and `MANAGER`
predate the commercial model change — the platform is sold direct to vendors, so
there is no court operator taking a revenue share and nobody from the platform
in the building. Migration `20260818000010_two_party_split` enforced the money
half of that with a CHECK on `fee_rule`. The roles are left in place rather than
deleted because `user_role_assignment.role` is an enum and Postgres cannot drop
a label; nothing assigns them.

---

## 6. Notifications

A four-rung ladder per event: `WEBSOCKET → WEB_PUSH → WHATSAPP → SMS`.

**Every rung currently reports `SKIPPED`** — no socket layer, no VAPID keys, no
BSP, no DLT registration. Each writes a row with the reason before a console
channel logs what would have been sent.

That is deliberate and is the whole design of `src/notify/channel.ts`: an empty
implementation returning success would tell every customer a code had been sent,
deliver none, and show a clean success rate in the logs. A tier that is
unavailable writes `SKIPPED` **with a reason**, so "the customer was never told"
is a fact in a table rather than an absence indistinguishable from an event that
never happened. When the ladder runs out entirely that logs at error level with
the message nobody received.

Separately, the **escalation ladder** (`src/dispatch/escalation.ts`) runs at
15 / 45 / 90 / 180 seconds when a stall does not acknowledge an order. At 90s it
blocks the stall from receiving more; at 180s it offers the customer a refund.

---

## 7. Verification

`npm run verify` — typecheck, then three checks that exist because the failure
they catch is silent:

| Check                                  | Catches                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `tests/conformance/console-authz.mjs`  | An endpoint authorising off the guard alone                     |
| `tests/conformance/client-contract.mjs`| A client calling a route that does not exist, or declaring a field the server never sends |
| `tests/design/contrast.mjs`            | WCAG failures across all six theme × app combinations           |
| `tests/design/tokens.mjs`              | A misspelt Tailwind class — renders nothing, invisible in light mode |

All four contain negative controls. A check that has never been seen failing is
a check nobody has verified.

Plus `npm test` (Vitest — unit, property, integration) and
`npm run test:constraints`, which drives the database against every constraint
and trigger and asserts each one refuses.

---

## 8. Proposed in v1.0, not used

Recorded so nobody re-adds one by reading the old document.

| Proposed                | What happened                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis**               | Never installed. Rate limiting is a Postgres table; there is no cache layer and at 8 orders/min there does not need to be.                        |
| **BullMQ**              | Never installed. Postgres `FOR UPDATE SKIP LOCKED` sweeps instead — see §3.                                                                       |
| **Socket.IO**           | Installed, **zero imports**. The WEBSOCKET notification rung skips for this reason.                                                              |
| **Argon2**              | Replaced by `node:crypto` **scrypt**. Argon2 and bcrypt are native modules that fail to build in a restricted sandbox; scrypt is memory-hard, in the standard library, and needs no toolchain. |
| **`date-fns` + `-tz`**  | `Intl.DateTimeFormat` covers it. No dependency.                                                                                                  |
| **Playwright**          | No end-to-end suite yet. The integration tests run against a real database instead. **This is a genuine gap**, not a decision.                    |
| **`@socket.io/redis-adapter`** | Follows Redis and Socket.IO.                                                                                                              |

### Still rejected, for the original reasons

| Rejected                              | Instead                  | Why                                                                                                                                                        |
| ------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MongoDB**                           | PostgreSQL               | A ledger needs unique constraints, FKs, row locks and multi-row transactions as *defaults*. Mongo makes each opt-in, and someone under deadline will skip one. |
| **Prisma / TypeORM / Sequelize**      | Kysely + plain SQL       | No ORM models triggers, partial indexes, `DO` blocks or `FOR UPDATE SKIP LOCKED` — all of which this schema depends on.                                       |
| **Kubernetes**                        | Managed containers       | Five processes serving 8 orders/min. K8s would be the most complex thing in the system by an order of magnitude.                                              |
| **Microservices**                     | Modular monolith         | Boundaries enforced by `eslint-plugin-boundaries` — 99% of the benefit at 1% of the operational cost.                                                         |
| **GraphQL**                           | REST + OpenAPI           | Three known clients, one team, and hard requirements for idempotency headers on money endpoints.                                                              |
| **Redux**                             | TanStack Query + Zustand | Nearly all state here is server state. Modelling it client-side is how a tracking screen drifts from the authoritative order.                                 |
| **Native apps**                       | PWA                      | Nobody installs an app to buy lunch. This is *why* the notification ladder exists.                                                                            |
| **Floating-point money / decimal.js** | Integer paise            | A decimal library still permits a float in at a boundary.                                                                                                    |
| **`jsonwebtoken`**                    | `jose`                   | Maintained, modern algorithms, no algorithm-confusion history.                                                                                                |
| **Serverless for the API**            | Long-running containers  | Worker loops and connection pooling both fight serverless.                                                                                                   |

---

## 9. Still undecided

| Open                   | Blocked on                          | Default if nobody decides             |
| ---------------------- | ----------------------------------- | ------------------------------------- |
| Payment aggregator     | Provider selection                  | Razorpay Route                        |
| **DLT registration**   | **Calendar time — start now**       | —                                     |
| WhatsApp BSP           | Commercial evaluation               | AiSensy or Gupshup                    |
| SMS provider           | Follows DLT                         | MSG91                                 |
| POS integration        | A named POS to integrate with       | —                                     |
| GST s.9(5) treatment   | External CA                         | —                                     |
| Cloud provider         | Cost and team familiarity           | AWS (ECS Fargate + RDS)               |

**DLT registration blocks taking a real order at all** — no OTP can reach a
phone without it, and it is the only item here with a lead time nobody controls.

The payment engine runs end to end against a stub provider that refuses to
construct in production. Everything downstream of the signature check — claim,
decide, apply, capture, expire — is production code, exercised on every local
order. Choosing an aggregator is one adapter against `PaymentProvider`, not a
rewrite.

---

## 10. The rules a coding agent or new engineer must not break

If you read nothing else in this repo:

1. **Money is integer paise.** No floats, no decimals, no strings, anywhere in
   `pricing`, `payments` or `ledger`. Ever.

2. **Order status is never assigned.** It changes only through the guarded
   transition in `src/ordering/transition.ts`, which takes a row lock, validates
   against the allow-list, and appends to `order_status_history` in the same
   transaction.

3. **No client request may move an order into a financially authoritative
   state.** PRD §7.4. Only a signature-verified provider event can. There is no
   "I have paid" button and there must never be one.

4. **A guard needs a test that proves it refuses.** Not a test that it allows
   the happy path — one that watches it say no. Four of the seven defects in PRD
   §2 were guards that silently did nothing.

5. **`tax.section9_5Applies` has no default.** The application refuses to boot
   without it. Do not add a fallback to make a test pass — put the value in the
   test config.

6. **The FSSAI dietary marks are not styleable.** Green circle for vegetarian,
   brown triangle for non-vegetarian, identical in both themes. They are a legal
   requirement, `tests/design/contrast.mjs` asserts each is declared exactly
   once, and no dietary information is **not** the same as vegetarian — the
   customer app renders nothing rather than guess.
