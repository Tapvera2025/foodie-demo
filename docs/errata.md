# Errata

Corrections to the specification found by **running** the system rather than by
reading it. Each entry records what the spec claimed, what was actually true,
how it surfaced, and what now prevents a regression.

This file exists because the specification set (PRD v5.2, TDD v1, Interface
Specs v1, Infra & Ops v1) was written before any of it executed. That is the
right order to work in, but it guarantees a residue of claims that are wrong in
ways no amount of re-reading will reveal. Reviewing prose finds prose problems.
Only execution finds execution problems.

Entries are appended, never edited.

---

## E-001 — Trigger name built with `%I_touch` was a syntax error on `"order"`

**Spec:** schema.sql §13, the `updated_at` trigger loop.

**Claim:** every table with `updated_at` gets a `BEFORE UPDATE` trigger that
maintains it.

**Reality:** the loop generated the trigger name with

```sql
format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I ...', t, t)
```

`%I` quotes an identifier when it needs quoting. For the reserved-word table
that produced

```sql
CREATE TRIGGER "order"_touch BEFORE UPDATE ON "order" ...
```

with `_touch` landing outside the quotes — a syntax error. `food_court_touch`
was fine. `"order"_touch` was not. The migration failed at that statement, so
**no** table got its trigger, including the ten that would have worked.

**How it surfaced:** first attempt to apply the migration to a real Postgres.

**Why review missed it:** the statement lives inside a dollar-quoted plpgsql
body, which to a static parser is a string literal. `pglast` parsed the file
without complaint. It only becomes SQL at `EXECUTE` time.

**Fix:** build the whole identifier and pass it to one `%I`:
`t || '_touch'`.

**Regression guard:** `tests/integration/migration-sql.test.ts` asserts no `%I`
is ever followed directly by identifier characters — the shape of the mistake,
not the one instance of it.

---

## E-002 — The append-only ledger was not append-only

**Spec:** PRD LED-01, schema.sql §14, `docs/tech/data.md`.

**Claim:** *"append-only, enforced by GRANT at the database level, not by
application discipline."* `data.md` went further and named
`REVOKE UPDATE ON ledger_entry` as the deciding argument for choosing Postgres
over Mongo.

**Reality:** the ledger accepted `UPDATE` and `DELETE`. Two independent
failures, either of which alone was sufficient:

1. **The revoke never ran.** The block was
   `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_rw') THEN ... ELSE
   RAISE NOTICE`. On any database where nobody had hand-created that role, the
   whole section degraded to a notice in a log nobody reads. That was the
   *default* state of a fresh database, including CI.
2. **Grants do not bind a superuser or the table owner.** Even with the role
   created and the revokes applied, they constrain `app_rw` and nothing else.
   Every developer connects as a superuser. So do a fair number of modest
   single-tenant deployments. The protection was absent from precisely the
   connection most capable of doing harm.

The second point is the one worth remembering: **a correctly-executed `REVOKE`
still would not have made the claim true.** Fixing only the missing role would
have produced a green test suite and a false guarantee, which is worse than the
red one.

**How it surfaced:** `scripts/test-constraints.ts`, the case *"UPDATE on
ledger_entry is refused"* — `The database ACCEPTED this. It must not.`

**Why review missed it:** the schema contained a literal
`REVOKE UPDATE, DELETE ON ledger_entry`, and a static test asserted that string
was present. Both were satisfied. The text was there; the enforcement was not.
An assertion that a policy is *written* is not an assertion that it *binds*.

**Fix:** `db/migrations/20260810000002_append_only_triggers.sql`. A
`BEFORE UPDATE OR DELETE ... FOR EACH STATEMENT` trigger calling
`refuse_mutation()` on `ledger_entry`, `order_status_history` and `audit_log`,
and `BEFORE DELETE` on `processed_event` and `dispatch_attempt`. A trigger
fires for every role including superusers and the owner. Statement-level rather
than row-level, so an `UPDATE` matching zero rows is still refused — the
correct answer to "may I edit the ledger?" does not depend on the `WHERE`
clause. The grants remain underneath as defence in depth, now creating the role
instead of skipping when it is absent, and degrading to a `WARNING` rather than
failing the deploy when the migration user lacks `CREATEROLE`.

**Regression guard:** four new live-database cases in
`scripts/test-constraints.ts` (`DELETE` on `ledger_entry`, `UPDATE` on
`order_status_history`, `DELETE` on `audit_log`, `DELETE` on
`processed_event`), plus static assertions in
`tests/integration/migration-sql.test.ts` that the trigger exists for each
table and that the role is created rather than skipped.

**Spec text still to change at next reissue:** PRD LED-01 says "enforced by
GRANT". It should say "enforced by trigger; grants are defence in depth".
`docs/tech/data.md` has been corrected in place.

---

## E-003 — `dbmate` could not be installed

**Spec:** `docs/tech/data.md`, migrations tooling.

**Claim:** migrations run via the `dbmate` npm package.

**Reality:** `dbmate` distributes a Go binary through optional platform
dependencies and failed on a clean install with *"Unable to locate dbmate
binary '@dbmate/darwin-arm64/bin/dbmate'"* — a known failure mode of that
distribution pattern.

**Fix:** `scripts/migrate.ts`, about sixty lines against the `pg` dependency we
already have. It reads the same `-- migrate:up` / `-- migrate:down` format, so
no migration file changed. It runs each up-section as **one** query
deliberately: the schema contains 144 semicolons inside dollar-quoted function
bodies, and splitting on `;` would corrupt it.

**Also corrected here:** the first version of the runner reported *"the SQL does
not apply cleanly"* when in fact the SQL had never run at all. An error message
that misattributes the failure costs more time than no error message.
`explainConnectionError()` now separates connection faults (`ECONNREFUSED`,
`3D000`, `28P01`) from SQL faults and prints the connection string masked.

---

## E-004 — Module boundaries were enforced by nothing

**Spec:** `tech.md`, module dependency rules.

**Claim:** `eslint-plugin-boundaries` prevents `pricing` from importing I/O.

**Reality:** the plugin was configured and reported zero errors because it
could not resolve any internal import. NodeNext `.js` specifiers need
`eslint-import-resolver-typescript`; without it every internal import was
classified as external and silently exempted. A rule that matches nothing
passes everything.

Separately, the `platform` element grouped pure helpers with `db.ts`, so even a
working resolver would have permitted `pricing → platform → db`.

**Fix:** added the resolver; split the element into `platform-pure` and
`platform-io`.

**Regression guard:** `tests/integration/boundaries.test.ts` asserts a
deliberately illegal import *is* reported — the plugin now has to prove it can
fail before we trust it to pass.

---

## E-005 — Two codegen scripts referenced tools that were never installed

**Spec:** `package.json` scripts, `docs/tech/data.md`.

**Claim:** `npm run codegen:db` generates Kysely types from the live schema, so
"the database is the source of truth and drift becomes a compile error".
`npm run codegen:api` generates request/response types from `openapi.yaml`.

**Reality:** neither `kysely-codegen` nor `openapi-typescript` was in
`devDependencies`. Both scripts would have failed on any clean checkout. And
because `codegen:db` had therefore never run, `src/platform/db.ts` still
carried `export interface Database {}` — an **empty** interface, meaning
`Kysely<Database>` knew about no tables whatsoever.

Nothing complained, because nothing had queried yet. The first repository
written against it would have failed to compile on every line, which is a poor
moment to discover the type layer does not exist.

**Fix:** `openapi-typescript` added as a devDependency; `codegen:api` kept.
`codegen:db` removed and replaced by `src/platform/schema.ts`, derived from the
DDL and maintained by hand.

**Why hand-maintained beats generated here:** codegen protects you at the
moment somebody remembers to run it. Between that moment and the next, the
types and the database drift and TypeScript reports nothing, because the types
*are* the compiler's only notion of truth — there is no second opinion for it
to consult. `tests/integration/schema-conformance.test.ts` supplies the second
opinion: it reads `information_schema` from a real database and fails on any
disagreement about a table, a column, its nullability, its `DEFAULT`, or
whether an enum was widened to `string`. That runs in CI against the Postgres
16 service on every push, so drift is caught on the commit that causes it.

**Regression guard:** the conformance test itself, which currently parses 357
columns across 30 tables. It asserts each interface is non-empty, so the
failure mode that produced this entry — a type layer that exists but describes
nothing — cannot recur silently.

---

## E-006 — `payment_order_uq` made a retried payment impossible

**Found:** 17 August 2026, while building the payment engine.
**Severity:** high. It would have surfaced as a customer unable to pay after a
declined first attempt, on a live pilot, at lunchtime.

The initial schema had:

```sql
CREATE UNIQUE INDEX payment_order_uq ON payment (order_id);
```

One payment row per order, for ever. Three things the PRD requires are
impossible under it:

| Requirement | What it needs |
| --- | --- |
| §7.2 "a retry is a new payment on the same order" | a second row |
| §8 "one order can have several payment attempts" | several rows |
| §9 case A — pay, close the browser, come back and pay again | a second row |

Under the old index the only way to record a second attempt was to overwrite
the first, which destroys the evidence of what happened on it — precisely the
record needed when a customer says they were charged twice.

Worth being clear about what was *right* here: an order must never have two
**live** intents at once, because that is how one basket produces two charges.
That guarantee was real and worth keeping. The index simply stated it far too
strongly, in a way that read as correct.

**Fix:** migration `20260817000007` narrows it from "one ever" to "one at a
time":

```sql
CREATE UNIQUE INDEX payment_one_live_per_order
  ON payment (order_id)
  WHERE status NOT IN ('FAILED', 'EXPIRED');
```

The predicate is an *exclusion* rather than a list of live states, deliberately.
A payment state added later and classified by nobody then counts as live and
restricts, rather than counting as dead and quietly permitting a second
simultaneous charge. The safe direction for an unclassified value is "no".

**Regression guard:** two constraint cases, not one. `a second LIVE payment on
one order is rejected` proves the restriction still holds; `retrying after a
failed payment IS allowed` proves the permission was actually granted. The
second exists because the suite would otherwise have passed unchanged against
the old index — **a check that only ever says "no" cannot tell you whether
"yes" still works.** That is a new shape of the E-002 pattern and the reason
this entry is worth reading twice.

---

## E-007 — `SUCCESS` could not express the interval the design depends on

**Found:** 17 August 2026, applying PRD §8.
**Severity:** medium, and structural rather than immediate.

`payment_status` ran `INITIATED, PENDING, SUCCESS, FAILED, …`. Meanwhile
`PAYMENTS_SPLIT_TIMING` already defaulted to `ON_ACKNOWLEDGED`, which means:
block the money at checkout, take it when the kitchen accepts, release it if no
stall ever does.

That is authorise-then-capture, and `SUCCESS` cannot say which of the two has
happened. The gap between them is not a detail — it is the entire mechanism
that stops a customer being charged for food nobody agreed to make. It is also
the shape of UPI single-block-multi-debit, which the PRD names as the correct
long-term primitive.

Nothing was broken, because nothing had been built on it yet. That is the only
reason this was cheap: the states were wrong before any money passed through
them.

**Fix:** `AUTHORIZED`, `CAPTURED`, `EXPIRED` and `PARTIALLY_REFUNDED` added;
`SUCCESS` and `INITIATED` retired behind a CHECK constraint, since PostgreSQL
cannot drop an enum label. `succeeded_at` renamed `captured_at` — it carried
the same ambiguity as the state it belonged to.

**Regression guard:** `the retired SUCCESS payment status is refused`, plus
`confirmationRequires()`, a one-line function whose only job is to make the
split-timing dependency explicit rather than implied by the ordering of code.

---

## E-008 — nothing enforced that a confirmed order had been paid for

**Found:** 17 August 2026.
**Severity:** the highest in this document, and it was a gap rather than a bug.

PRD §7.4 states the rule plainly: *no client request may transition an order
into a financially authoritative state.* It was stated in a document, which
means it was enforced by whoever last read the document. Any `UPDATE "order"
SET status = 'PAYMENT_CONFIRMED'` — from a controller, a script, a psql session
— succeeded, whether or not a rupee had moved.

**Fix:** a trigger, because the check is cross-table and cannot be a CHECK:

```sql
CREATE TRIGGER order_confirmation_requires_payment
  BEFORE UPDATE ON "order" ...
```

It refuses `PAYMENT_CONFIRMED` unless a payment on that order is already
`AUTHORIZED` or `CAPTURED`.

The immediate consequence was that `seed-orders.ts` stopped working, which is
the constraint doing its job: the seed had been fabricating paid orders with no
payment behind them. Its own header says fabricated rows "would produce a board
that looks right and money that is fiction". It now writes the payment row the
webhook would have written.

**Regression guard:** `an order cannot become PAYMENT_CONFIRMED without an
authorised payment`, with a control that confirms a *properly paid* order in
the same test — otherwise the check would also pass on a database where
`PAYMENT_CONFIRMED` is unreachable full stop.

---

## The pattern

E-002, E-004 and E-005 are the same mistake in different clothing: a guard
present as text, absent as behaviour, and — in the first two — verified by a
test that only checked the text. Each was found by making something try to do
the forbidden thing and watching whether it succeeded.

The common structure is a check whose *failure mode is silence*. A `REVOKE`
against a role that does not exist. A lint rule that resolves no imports. A
codegen script for a package that is not installed. None of them error; they
all just quietly do nothing, and an absence of complaints reads exactly like
success. Every one of these was introduced by someone writing the correct thing
and never watching it refuse.

The standing rule that comes out of this: **for every constraint the spec
claims, write the violation and assert it fails.** Where a control insert is
needed to make the violation meaningful, assert the control succeeds too — an
earlier version of `test-constraints.ts` ran `INSERT ... SELECT ... LIMIT 1`
against an empty database, inserted zero rows, threw nothing, and reported a
false PASS on every single check.

E-006 adds a corollary that took a while to see. That rule protects against a
guard that does not refuse what it should. It says nothing about a guard that
refuses *more* than it should — and `payment_order_uq` was exactly that: a
constraint doing its job so enthusiastically that it forbade a documented
requirement. A suite made entirely of "this must be rejected" cases cannot
detect it, because every such case still passes.

So: **where a rule permits something, test the permission too.** For every
"this must be refused", ask what the adjacent legitimate act is, and assert
that one succeeds. The pair is the specification; either half alone is a
half-truth that reads like the whole.

E-008 adds the other corollary, which is about where rules live. §7.4 was
written down, agreed, and enforced by nothing. A rule in a document is enforced
by whoever last read the document; a rule in a trigger is enforced by the
database. Any invariant important enough to be stated in the PRD in bold should
be asked, on the same day, whether it can be made a property of the schema —
and if it cannot, why not.
