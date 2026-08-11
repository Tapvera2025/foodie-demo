# Technology Stack

**Food Court QR Ordering Platform · Tapvera Technologies Pvt Ltd**
Version 1.0 · 10 August 2026 · Status: proposed, pending engineering sign-off

This is the single source of truth for _what we build with_. It is derived from
PRD v5.2, the Technical Design Document v1.0 and Infrastructure & Operations v1.0.
Where this file and the docx set disagree, **this file wins in the repo** — raise a
PR to fix whichever one is wrong.

| Layer             | Detail                                                       |
| ----------------- | ------------------------------------------------------------ |
| Frontend          | [`docs/tech/frontend.md`](docs/tech/frontend.md)             |
| Backend           | [`docs/tech/backend.md`](docs/tech/backend.md)               |
| Data              | [`docs/tech/data.md`](docs/tech/data.md)                     |
| Integrations      | [`docs/tech/integrations.md`](docs/tech/integrations.md)     |
| Infrastructure    | [`docs/tech/infrastructure.md`](docs/tech/infrastructure.md) |
| Tooling & testing | [`docs/tech/tooling.md`](docs/tech/tooling.md)               |

---

## 1. The five principles behind every choice

Read these before arguing about a library. Most disagreements resolve here.

1. **Correctness over throughput.** The load model (Infra & Ops §1.1) is ~8 orders
   per minute at burst, per court. This system will never fall over from traffic.
   It will fall over from a duplicated webhook or a refund that stopped retrying.
   Every time performance and provability conflict, pick provable.

2. **The database enforces the rules, not the application.** Unique constraints,
   foreign keys, row locks, `REVOKE UPDATE` on the ledger. A tool that makes those
   awkward to express is the wrong tool, however pleasant its API.

3. **Boring, widely-known technology.** A small team in Ahmedabad or Bangalore has
   to hire for this and debug it at 1pm on a Saturday. Novelty is a cost.

4. **One deployable until scale says otherwise.** Modular monolith, hard internal
   boundaries, API and worker from one image. No service mesh, no Kubernetes, no
   event bus, until a real constraint demands it.

5. **Spec-first for anything crossing a boundary.** `contracts/openapi.yaml` and
   `db/migrations/*.sql` are authoritative artifacts, not generated afterthoughts.
   Types flow _from_ them into code, never the reverse.

---

## 2. Stack at a glance

| Concern               | Choice                           | Version | Notes                                                       |
| --------------------- | -------------------------------- | ------- | ----------------------------------------------------------- |
| Language              | TypeScript                       | 5.6+    | `strict: true`. No `any` in financial modules.              |
| Runtime               | Node.js                          | 22 LTS  | Matches the shipped `Dockerfile`.                           |
| Backend framework     | NestJS                           | 11      | Chosen for enforceable module boundaries (TDD §2.1).        |
| HTTP adapter          | Express                          | 5       | Perf is a non-issue here; ecosystem maturity wins.          |
| Frontend              | React + Vite                     | 19 / 6  | One codebase, three build targets: PWA, KDS, console.       |
| Styling               | Tailwind CSS                     | 4       |                                                             |
| Server state          | TanStack Query                   | 5       | Fits the "refetch authoritative state" rule (CUS-TRK-04).   |
| Client state          | Zustand                          | 5       | Cart and session only. No Redux.                            |
| Database              | PostgreSQL                       | 16+     | Transactional core and ledger.                              |
| Query layer           | Kysely                           | 0.27+   | Typed SQL builder. Types generated _from_ the live schema.  |
| Migrations            | `scripts/migrate.ts`             | —       | ~60 lines over `pg`. Plain `.sql`; `schema.sql` runs as-is. |
| Cache / queue backend | Redis                            | 7+      | Cache, locks, presence, rate limits, BullMQ.                |
| Job queue             | BullMQ                           | 5       | Every async path.                                           |
| Realtime              | Socket.IO                        | 4       | With `@socket.io/redis-adapter`. Broadcast only.            |
| Validation            | Zod                              | 3       | Shared between frontend and backend.                        |
| API contract          | OpenAPI                          | 3.1     | Spec-first. `openapi-typescript` generates types.           |
| Logging               | Pino                             | 9       | Structured JSON, allow-list redaction.                      |
| Auth                  | jose + argon2                    | —       | EdDSA JWTs, Argon2id passwords.                             |
| Testing               | Vitest + fast-check + Playwright | —       | Property tests are mandatory for pricing and ledger.        |
| Containers            | Docker                           | —       | See `Dockerfile`.                                           |
| CI                    | GitHub Actions                   | —       | See `ci.yml`.                                               |
| Hosting               | Managed containers               | —       | ECS Fargate, Cloud Run or App Platform. **Not Kubernetes.** |

---

## 3. Rejected technologies

Recorded so nobody re-litigates them in month four. Each has a real reason.

| Rejected                              | Instead                    | Why                                                                                                                                                                                                                      |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MongoDB**                           | PostgreSQL                 | PRD correction #5. A ledger needs unique constraints, FKs, row locks and multi-row transactions as _defaults_. Mongo can do them; it makes each one opt-in, and a future engineer under deadline pressure will skip one. |
| **Prisma**                            | Kysely + plain SQL         | Weak control over `SELECT FOR UPDATE`, lock semantics and raw DDL. `schema.sql` uses triggers, `DO` blocks and `GRANT`/`REVOKE` that no ORM models. The database is the source of truth; generate types from it.         |
| **TypeORM / Sequelize**               | Kysely                     | Same reason, plus a history of surprising migration behaviour on production data.                                                                                                                                        |
| **Kubernetes**                        | Managed containers         | Four containers serving 8 orders/min. K8s would be the most complex thing in the system by an order of magnitude, and it would be complexity nobody on the team is on call for. Revisit past ~50 courts.                 |
| **Microservices**                     | Modular monolith           | PRD principle 15. Boundaries are enforced by lint rules (`eslint-plugin-boundaries`), which is 99% of the benefit at 1% of the operational cost.                                                                         |
| **Kafka / event bus**                 | BullMQ on Redis            | Job semantics with retries and a dead-letter queue is what we need. Event streaming is not.                                                                                                                              |
| **GraphQL**                           | REST + OpenAPI             | Three known clients, one team, and a hard requirement for idempotency headers and precise cache semantics on money endpoints.                                                                                            |
| **Redux / Redux Toolkit**             | TanStack Query + Zustand   | Nearly all state here is server state. Modelling it client-side is how the tracking screen drifts from the authoritative order.                                                                                          |
| **Native iOS/Android apps**           | PWA                        | PRD §6.3. Nobody installs an app to buy lunch. (This is _why_ the notification ladder in §10 exists.)                                                                                                                    |
| **Floating-point money / decimal.js** | Branded `Paise` integers   | PRD PAY-05. A decimal library still permits a float to enter at a boundary. An integer branded type makes it a type error.                                                                                               |
| **`jsonwebtoken`**                    | `jose`                     | Maintained, modern algorithm support, no historic algorithm-confusion footguns.                                                                                                                                          |
| **Moment.js**                         | `date-fns` + `date-fns-tz` | Deprecated upstream.                                                                                                                                                                                                     |
| **Serverless functions for the API**  | Long-running containers    | WebSockets, BullMQ workers and connection pooling all fight serverless.                                                                                                                                                  |

---

## 4. Version and dependency policy

- **Node and Postgres track LTS.** Upgrade within one quarter of a new LTS; never
  run an EOL runtime in production.
- **Lockfile is committed** and `npm ci` is the only install command in CI.
- **Renovate** raises dependency PRs weekly. Patch and minor auto-merge on green
  CI; major versions need a human.
- **`npm audit --audit-level=high` blocks merge.** No exceptions without a dated
  waiver in the PR.

### Adding a dependency

Ask, in order:

1. Can the platform or an existing dependency do it? (`fetch`, `crypto`,
   `Intl`, `AbortController` cover more than people expect.)
2. Is it more than ~200 lines of code we'd otherwise write?
3. Is it maintained — a release in the last 12 months, and more than one
   maintainer?
4. Does it touch money, auth or PII? If yes, it needs a second reviewer and a
   note in the PR describing what it does with that data.

Anything entering `src/pricing`, `src/payments` or `src/ledger` needs an ADR.
Those three modules should have almost no dependencies at all — `pricing` is
specified as pure functions with no I/O (TDD §2.1) and should import nothing but
the money type.

---

## 5. Things that are deliberately not decided yet

| Open                   | Blocked on                                  | Default if nobody decides             |
| ---------------------- | ------------------------------------------- | ------------------------------------- |
| Payment aggregator SDK | PRD §31.1 — provider selection, gate week 4 | Razorpay Route                        |
| WhatsApp BSP           | Commercial evaluation, gate week 2          | AiSensy or Gupshup                    |
| SMS provider           | DLT registration lead time                  | MSG91                                 |
| Cloud provider         | Cost and team familiarity                   | AWS (ECS Fargate + RDS + ElastiCache) |
| Managed observability  | Free-tier limits at pilot scale             | Grafana Cloud + Sentry                |

None of these block weeks 1–4 of the build. Start.

---

## 6. The three rules a coding agent or new engineer must not break

If you read nothing else in this repo:

1. **Money is `Paise`, an integer branded type.** No floats, no decimals, no
   strings, anywhere in `pricing`, `payments` or `ledger`. Ever.
2. **Order status is never assigned.** It changes only through a guarded command
   in `src/ordering/commands/`, which takes a row lock, validates the transition
   against the allow-list, and appends to `order_status_history` in the same
   transaction.
3. **`tax.section9_5Applies` has no default.** The application must refuse to
   boot without it. Do not add a fallback value to make a test pass — write the
   value into the test config instead.
