# Data Technology

← [`tech.md`](../../tech.md) · Derived from PRD v5.2 §18 · TDD v1.0 §3, §8 · `schema.sql`

The most opinionated file in the repo, because this is where the money lives.

---

## Stores

| Store         | Choice             | Holds                                                                                                                                                              | Durability       |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Primary       | PostgreSQL 16+     | Courts, tables, vendors, users, sessions, carts, orders, payments, refunds, credit, fee rules, **ledger**, settlements, audit, dispatch attempts, processed events | Managed, PITR    |
| Documents     | Postgres **JSONB** | Menu option groups, POS payload snapshots, fee-rule snapshots                                                                                                      | Same             |
| Cache / queue | Redis 7+           | Menu cache, rate limits, locks, socket presence, BullMQ                                                                                                            | **None assumed** |
| Objects       | S3-compatible      | Menu images, QR print assets                                                                                                                                       | Provider-managed |

> **Nothing durable may live only in Redis.** If flushing Redis in staging loses
> business data, the design is wrong (Infra & Ops INF-09).

---

## Why PostgreSQL, not MongoDB

PRD correction #5, and worth restating because it will come up again.

Mongo _can_ do multi-document transactions. The objection is that Postgres makes
the properties this system requires the **default**, and Mongo makes each one
opt-in:

| Requirement                        | Postgres                                         | Mongo                                                   |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `order.idempotency_key` unique     | `CREATE UNIQUE INDEX`                            | Unique index, but no FK to catch orphans                |
| Webhook dedupe                     | Unique constraint, insert-and-catch              | Same, but easy to implement as read-then-write and race |
| Row lock before a state transition | `SELECT … FOR UPDATE`                            | `findAndModify` gymnastics                              |
| Append-only ledger                 | `BEFORE UPDATE OR DELETE` trigger that raises    | Convention only                                         |
| Balanced entries per order         | `CHECK` + a view + a nightly assertion           | Application code                                        |
| Money as integers                  | `BIGINT`                                         | `NumberLong`, or a `Double` if someone is careless      |

The deciding argument is the append-only ledger. A future engineer under
deadline pressure cannot "just quickly fix" a ledger row. That is the whole
point.

**Corrected once, and the correction is the interesting part.** This row
originally read `REVOKE UPDATE, DELETE`, and the schema implemented exactly
that. Running the constraint suite against a live Postgres showed the ledger
was editable anyway, for two independent reasons: the `REVOKE` was conditional
on a role nobody had created, and grants do not bind a superuser or the table
owner — which is every developer and plenty of small deployments. Two locks,
both open. A trigger binds every role, so that is now the guarantee and the
grants are only defence in depth. See `db/migrations/20260810000002` and
`docs/errata.md`.

---

## Query layer: Kysely, not an ORM

```ts
// Typical transition — the shape every ordering command takes.
await db.transaction().execute(async (trx) => {
  const order = await trx
    .selectFrom('order')
    .selectAll()
    .where('id', '=', orderId)
    .forUpdate() // <- the reason we are not using an ORM
    .executeTakeFirstOrThrow();

  assertTransitionAllowed(order.status, next);

  await trx.updateTable('order').set({ status: next }).where('id', '=', orderId).execute();
  await trx.insertInto('order_status_history').values({/* ... */}).execute();
});
```

|                      |                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Kysely**           | Typed SQL builder. You write SQL shapes; it types them. Full control of locks, CTEs, partial indexes, `ON CONFLICT`. |
| **`src/platform/schema.ts`** | Hand-maintained table types, guarded by a conformance test that reads `information_schema` in CI. Replaced `kysely-codegen`, which was referenced by package.json but never installed, so it had never run — see `docs/errata.md` E-005. |
| **`pg`**             | Driver. Explicit pool sizing.                                                                                        |

**Prisma was rejected**: weaker row-lock control, a query engine binary in the
image, and no way to express the triggers, `DO` blocks and `GRANT`/`REVOKE` that
`schema.sql` depends on. `schema.sql` §13–§14 is not expressible in any ORM's
schema language, so an ORM would own half the schema and plain SQL the other
half — the worst arrangement available.

---

## Migrations: plain SQL

**A small Node runner** — `scripts/migrate.ts`. Migrations are `.sql` files with
`-- migrate:up` / `-- migrate:down` markers.

We started with the npm `dbmate` package and dropped it. It ships a Go binary
through optional platform dependencies, and on a fresh macOS arm64 install it
failed with "Unable to locate dbmate binary '@dbmate/darwin-arm64/bin/dbmate'".
A binary-distribution wrapper is a silly thing to have standing between a
developer and their database when the format is this simple and `pg` is already
a dependency.

The runner executes each up-section as ONE query rather than splitting on
semicolons — the schema contains dollar-quoted function bodies with 144
semicolons inside them, and naive splitting would corrupt it. It supports a
`-- migrate:no-transaction` marker for the `CREATE INDEX CONCURRENTLY` case.

```
db/migrations/
  20260810000001_init.sql          # = schema.sql, verbatim
  20260812093000_add_credit_expiry_index.sql
```

Why plain SQL: the initial schema already _is_ SQL, including triggers, generated
columns, partial indexes, invariant views and grant revocation. A migration DSL
would either fail to express those or wrap them in `executeRaw` anyway.

### Migration rules (Infra & Ops §6.2)

Every migration must be **backward compatible with the release currently running**,
because during a rolling deploy both versions hit the same schema.

| Change            | How                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------- |
| Add a column      | Nullable or defaulted. One step.                                                    |
| Drop a column     | Three releases: stop writing → stop reading → drop.                                 |
| Rename            | Never. Add, backfill, dual-write, cut over, drop later.                             |
| Add `NOT NULL`    | Add nullable → backfill in batches → `NOT VALID` → `VALIDATE CONSTRAINT`.           |
| Add an index      | `CREATE INDEX CONCURRENTLY`. A plain create takes a write lock and stalls checkout. |
| Add an enum value | Safe. Removing one is not — treat enum values as permanent.                         |
| Backfill          | Batched, in a job. Never inside the migration transaction.                          |

CI runs migrations from empty on every push, then attempts each PRD §18.3
violation and asserts the **database** rejects it.

---

## Money

```ts
export type Paise = number & { readonly __brand: 'Paise' };
```

- Every monetary column is `BIGINT`. There is no `NUMERIC`, no `DECIMAL`, no
  `FLOAT` anywhere in a financial path.
- `BIGINT` returns as a string from `pg` by default. **Configure the type parser
  once, at startup**, and assert the value is a safe integer:

```ts
import pg from 'pg';
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 out of safe range: ${v}`);
  return n;
});
```

₹92,233,720,368 is the safe-integer ceiling in paise. A single order will not
approach it; a lifetime settlement total will not either. If that ever changes,
move to `BigInt` — but do it deliberately, not by accident.

- Rounding is **half-up**, always (TDD §3.1). Not banker's rounding. A vendor must
  be able to reproduce their statement with a calculator.
- Residual paise go to the platform as an `ADJUSTMENT` ledger entry, never to the
  vendor and never to the customer.

---

## Connection pooling

| Setting                     | Value                     | Reason                                                                  |
| --------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| API pool                    | 10 per instance           | 2 instances × 10 = 20, comfortably inside a small managed Postgres.     |
| Worker pool                 | 5 per instance            | Workers are I/O-bound on providers, not the database.                   |
| Statement timeout           | 10 s (API), 60 s (worker) | A checkout query that takes 10 s has already failed the customer.       |
| Lock timeout                | 3 s                       | Prevents an escalation sweeper from stalling behind a long transaction. |
| Idle in transaction timeout | 15 s                      | Catches a forgotten `await` holding a row lock.                         |

No PgBouncer at pilot scale. Add it (transaction mode) past ~10 courts, and note
that transaction-mode pooling breaks session-level features — we use none today,
which is deliberate.

---

## Redis usage

| Use              | Key pattern         | TTL    | Loss behaviour                                                       |
| ---------------- | ------------------- | ------ | -------------------------------------------------------------------- |
| Menu cache       | `menu:v:{vendorId}` | 300 s  | Refetch from Postgres                                                |
| Rate limits      | `rl:{scope}:{id}`   | window | Limits reset. Acceptable.                                            |
| Distributed lock | `lock:{resource}`   | 30 s   | Postgres row locks are the real guard; Redis locks are advisory only |
| Socket presence  | adapter-managed     | —      | Clients reconnect                                                    |
| BullMQ           | `bull:{queue}:*`    | —      | **Jobs are lost.** See below                                         |

BullMQ jobs living only in Redis is the one real exposure. Mitigations:

- Redis persistence (AOF) enabled on the managed instance.
- Every durable workflow has a **database-backed reconciler** that can rebuild
  lost work: `escalation_state.next_run_at` for the ladder,
  `refund.next_retry_at` for refunds, and the daily reconciliation job for
  payments. Losing Redis delays work; it does not lose it.

---

## Backup and retention

- Managed Postgres, automated daily backups, **PITR to any second in the last 7
  days**, extended to 35 once there is a second court.
- **A restore must be rehearsed before pilot go-live** (PRD DATA-04). Rehearsed
  means performed into a scratch instance with row counts checked. Record the
  actual restore time — that number is the RTO.
- Redis is not backed up, by design.
- Retention policy (PRD SEC-11) is configuration: order history, phone numbers
  and notification records each have a defined period and a purge job.

---

## Rejected

| Rejected                      | Why                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| MongoDB                       | See above. Correction #5.                                                                                                      |
| Prisma / TypeORM / Sequelize  | Lock control, raw DDL, and a schema the ORM cannot own.                                                                        |
| `NUMERIC` for money           | Correct arithmetic, but permits a float at a boundary and invites string/number confusion in JS. Integer paise is unambiguous. |
| A separate analytics database | `analytics_event` in Postgres is ample at this volume. Revisit at ~10 courts.                                                  |
| Redis as a source of truth    | Any design where losing the cache loses data is rejected on sight.                                                             |
| Read replicas                 | No read pressure. Adds replication lag as a class of bug for zero benefit.                                                     |
