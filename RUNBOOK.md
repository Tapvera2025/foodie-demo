# Running the system

`.env` currently points at the **Docker** Postgres on port **5433**. Both paths
below produce the same database; pick one and leave `.env` matching it.

---

## The short version — Docker

```bash
open -a Docker                        # the daemon must be running first
npm run db:up                         # postgres + redis from docker-compose.yml

npm install
npm run migrate:up                    # 17 migrations
npm run seed:dev                      # one court, three stalls, menus, logins
npm run dev:all                       # api + worker + pwa + kds + console
```

### Why 5433 and not 5432

Because this machine already runs a Homebrew Postgres on 5432, and the two
cannot share it. The failure when they collide is genuinely misleading: the
Homebrew server binds `127.0.0.1` and wins, the container binds `*` and loses,
so `docker ps` reports a healthy container while every connection lands on the
*other* server. With the container's credentials that comes back as

```
Authentication failed for postgres://***@localhost:5432/foodcourt
```

— which sends you hunting for a password problem when the real fault is that
you are talking to a different database entirely.

So the compose file takes the host port from `POSTGRES_PORT`, and `.env` sets
it to 5433 alongside a matching `DATABASE_URL`. Compose reads the same `.env`,
so the container's binding and the app's connection string cannot drift apart.
Anyone whose 5432 is free can delete the line and get the default back.

`npm run db:doctor` reports which server you are actually reaching.

## The short version — Homebrew Postgres

Equally supported. Swap the `DATABASE_URL` in `.env` for the commented-out line
just below it, drop `POSTGRES_PORT`, and skip `db:up`:

```bash
brew services start postgresql@16     # if it is not already running
createdb foodcourt                    # first time only; harmless if it exists

npm install
npm run migrate:up                    # 17 migrations
npm run seed:dev
npm run dev:all
```

Nothing else differs. Redis is declared in `.env` and never connected to —
there is no Redis client in `package.json`, and rate limiting is a Postgres
table — so the compose file's Redis service is unused either way.

Then open

| | | |
| --- | --- | --- |
| **http://localhost:5173** | as a customer | scan → order → pay → track |
| **http://localhost:5174** | as the kitchen | accept → ready → hand over |
| **http://localhost:5175** | as the platform | create courts and stalls, onboard them |

`Ctrl-C` stops all five processes and their children.

### Adding a food court and a stall

Sign in to the console as `ops@tapvera.example.com` — the seed prints the
password. That account holds `SUPER_ADMIN`, `PLATFORM_OPS` and
`PLATFORM_FINANCE`: three roles, one login. `SUPER_ADMIN` alone holds a single
permission (`tenant.manage`), so it can create a court and **not** a stall.

A new stall is created in **onboarding** and cannot take an order until the
§5.2 gate passes. The checklist on its page lists exactly what is missing. Two
of the eleven items cannot be cleared from the console yet:

- **Menu** — comes from the CSV import endpoint
  (`POST /api/v1/console/vendors/:id/menu/import`), which has no screen.
- **Kitchen login** — created by the platform, and there is no screen for that
  either.

Both are seeded for the three development stalls, so the fastest way to see a
stall go live is to onboard one of those rather than a brand new one. A court
you create yourself also has **no QR token**, so nothing can scan into it —
issuing one is not built.

---

## What each process is for

| Process | Port | What breaks without it |
| --- | --- | --- |
| `api` | 3000 | Everything |
| `worker` | — | **A paid order never reaches a kitchen.** No escalation, no notifications, no payment expiry |
| `pwa` | 5173 | The customer |
| `kds` | 5174 | The kitchen |

The worker is the one people forget. Without it an order sits in
`PAYMENT_CONFIRMED` forever and the board stays empty, which looks exactly like
a payment failure and is not one.

Run them separately if you prefer four terminals:

```bash
npm run dev          npm run dev:worker
npm run dev:pwa      npm run dev:kds
```

---

## The full walkthrough

### As a customer — http://localhost:5173

1. **Pick a court.** The dev entry screen stands in for scanning a poster. It
   only exists outside production, and it exists because the QR token *is* the
   credential — there is no login to bypass, so an endpoint that hands tokens
   out would let anyone order from anywhere.

2. **Choose a stall, then tap ADD on something.**

3. **Enter a mobile number.** Any Indian format works — `9876543210`,
   `+91 98765 43210`, `09876543210` all normalise to the same customer.

4. **The code appears on the screen.** No SMS is sent, so in development the
   code shows in a dark panel below the input a second or two after you request
   it. **Tap it to fill the field.**

   It is also printed in the API log if you prefer:

   ```
   api    │ WARN: DEV ONLY — OTP for +91 ***** 43210 is 493028
   ```

   No SMS is sent and none can be. India requires DLT registration of the
   sender entity, header and every template before transactional SMS is
   delivered, and that has not been done. Setting `OTP_CHANNEL=sms` makes the
   API refuse to start rather than silently tell customers a code was sent.

   The panel is fed by `GET /auth/otp/dev/latest`, a route that 404s in
   production. It is a *separate endpoint* rather than a field on the send
   response on purpose: a production route that returns the OTP under an
   `if (dev)` is one refactor away from leaking every code to every caller.
   The plaintext comes from the channel's memory, never the database —
   `code_hash` is an HMAC and the code is not stored.

5. **Check your basket survived.** The item you tapped should still be there.
   That is the single property most likely to break in this flow.

6. **Review and pay.** The bill shows every line before you commit — item
   total, GST, and any platform fee. Nothing appears for the first time on the
   payment screen.

7. **Tap Pay now.** The payment resolves by itself — there is no aggregator, so
   the server forges a stub-provider webhook and runs it through the real
   ingestion path, signature check included.

   It fires automatically rather than from a button, because in production the
   customer leaves for a UPI app and the confirmation arrives on its own; a
   button that must be pressed first teaches the wrong shape. The client still
   never confirms a payment — `PAYMENT_CONFIRMED` is reachable only from a
   verified provider event, so the success screen is a report of what the
   server said, not a claim the browser made.

8. **You get a receipt**: a green screen with "Payment successful", the amount,
   and your order number, then it moves to tracking by itself. The order
   reaches the kitchen board within about 4.5 seconds — worker tick 1.5s plus
   the board's 3s poll.

### As the kitchen — http://localhost:5174

Sign in with a stall login printed by `npm run seed:dev`. Then:

**Accept → Start cooking → Ready → Hand over.**

When you mark an order Ready, watch the `api` lines again:

```
api    │ WARN: DEV ONLY — would send to +91 ***** 43210:
         Order A27 is ready. Collect from Spice Garden.
```

---

## Watching the escalation ladder

Place an order and then **do not accept it.** With the default thresholds:

| At | What happens |
| --- | --- |
| 15s | Worker redispatches. Customer sees nothing |
| 45s | Redispatches again |
| 90s | **Stall blocked from new orders**, manager alerted. The board shows "New orders paused" |
| 180s | Order fails; customer offered a one-tap full refund |

The customer-facing copy never blames the stall at any rung — a diner who is
told "the kitchen ignored you" takes it up with a person who may have had a
tablet die on them.

To not wait three minutes, shorten them in `.env` and restart the worker:

```
DISPATCH_LADDER_STEP1_SECONDS=3
DISPATCH_LADDER_STEP2_SECONDS=6
DISPATCH_LADDER_STEP3_SECONDS=9
DISPATCH_LADDER_STEP4_SECONDS=12
```

They must strictly increase. The config loader refuses to start otherwise,
because a ladder that does not can block a stall before the first retry has
been attempted.

---

## Resetting

```bash
npm run reset:orders     # clears orders, keeps court, stalls, menus, logins
npm run seed:orders      # optional: a board pre-populated in every state
```

`reset:orders` is deliberately loud and refuses to run in production. The
ledger and status history refuse `DELETE` and `TRUNCATE` from every role
including superusers, so this suspends those guards by name, in a transaction,
and then proves they came back. An intentional door beats an unnoticed gap.

To start completely over:

```bash
dropdb foodcourt && createdb foodcourt && npm run setup
```

---

## Verifying rather than trusting

```bash
npm run verify:db        # migrates from empty and proves every constraint
npm test                 # unit, property and integration
npm run typecheck        # api + pwa + kds
npm run lint
```

`verify:db` is the one that matters. It does not check that constraints are
*configured* — it attempts each forbidden thing and requires the database to
refuse, with a control insert that must succeed so a check cannot silently pass
against an empty table.

---

## When it does not work

| Symptom | Cause | Fix |
| --- | --- | --- |
| `config_invalid` on boot | A required variable is unset | The message names it. `TAX_SECTION_9_5_APPLIES` has no default on purpose |
| `ECONNREFUSED` on 5432 | Postgres is not running | `brew services start postgresql@16`, then `npm run db:doctor` |
| Migration 007 fails on `DISABLE TRIGGER` | Your database user does not own the tables | Connect as the owner, or the user who ran migration 001 |
| Board stays empty after paying | The worker is not running | `npm run dev:worker` |
| `EADDRINUSE` on 3000 or 5173 | An orphan from a previous run | `lsof -ti:3000 \| xargs kill`. `dev:all` kills process groups to prevent this |
| `relation "..." already exists` | A migration recreates an index the initial schema already made | Fixed in 009. If it recurs, check `20260810000001_init.sql` before adding an index |
| `Cannot access 'X' before initialization` | Two files import each other | `npm test` now catches this — `tests/integration/module-graph.test.ts`. Move the shared value to a leaf that imports nothing |
| `notification_ladder_exhausted` on seeded orders | Old seed data has no customer attached | `npm run reset:orders && npm run seed:orders` |
| `X is append-only; TRUNCATE is not permitted` during reset | A guarded table reached by CASCADE | Fixed — `reset:orders` now reads the guarded set from `pg_trigger` |
| `VENDOR_DISPATCH_BLOCKED` when seeding | The escalation ladder blocked a stall and the orders that would clear it were deleted | Fixed — `reset:orders` unblocks stalls. To clear by hand: `UPDATE vendor SET dispatch_blocked_at = NULL;` |
| Kitchen board flickers between login and the queue | Fixed — was two sources of truth for "signed in" plus a query's `isError`, which is false during a retry | Pull the change. If it recurs, the token is being cleared without notifying React |
| Kitchen board drops to login every 30 minutes | The staff token TTL, working as specified | Sign in again. See the note below — 30 minutes is wrong for a mounted tablet and is a real open question |
| Payment screen spins for ever | Fixed — the auto-confirm was on a `setTimeout` that StrictMode's effect cleanup cancelled and the ref guard stopped rescheduling | Pull the change. After 10s the screen now offers "Check again" and, in dev, a manual webhook button |
| "Pay now" bounces back to the stall list | Fixed — `endCheckout()` emptied the cart, which tripped Checkout's own empty-basket redirect, and that won the race to `/pay` | Pull the change. The orders WERE being placed and paid; nothing was lost, it just never showed |
| PWA loads unstyled | Tailwind token missing | `npm run build:pwa` — the build reports it; `tsc` cannot |
| OTP never arrives | It is not meant to | Read the API log. See step 4 above |
| `PAYMENTS_PROVIDER=stub in production` | The stub refuses production | Correct. It confirms payments nobody made |

---

## The kitchen session is 30 minutes, and that is a problem

`TOKEN_TTL_SECONDS.staff` is 30 minutes, per Interface Specs §2. For an office
browser that is a sensible number. For a tablet bolted to a wall above a fryer,
it means a cook re-types a password roughly sixteen times across a service —
and the predictable result is a shorter password, or one written on the tablet
case, which is worse than a longer session.

Three ways out, in rough order of how much they cost:

1. **Raise the staff TTL for this surface.** Cheapest, and it weakens a spec'd
   security parameter for every staff user rather than just the kitchen.
2. **Add refresh tokens.** The error catalogue already has
   `REFRESH_TOKEN_REUSED`, so the shape was anticipated. Correct, and the most
   work.
3. **Use the `device` token type.** It exists, it is 30 days, and it was
   designed for exactly this — a mounted tablet paired once to one stall. The
   device-pairing flow was considered and set aside in favour of per-user
   email/password, which was the right call for attribution: a rejection needs
   to name a person, not a tablet. A device token for the *session* and a user
   token for *actions* is the version that gets both.

Not decided here, because it reverses an earlier deliberate choice. Flagging it
because the flicker made it look like a bug when it was the specification.

---

## What is not running here

Being explicit, because "it works locally" is doing a lot of work above:

- **No payment aggregator.** The stub is exercised end to end and refuses to
  construct in production. Choosing Razorpay Route or another provider is one
  adapter against `PaymentProvider`.
- **No SMS or WhatsApp.** DLT registration is calendar-bound and blocks taking
  a real order. Every notification tier reports `SKIPPED` with a reason and
  writes a row for it, so "nobody was told" is a fact in the table rather than
  an absence.
- **No refunds.** The state machine has the states and the retry schedule is a
  tested library, but nothing calls the provider yet. A rejected order today
  leaves a charged customer.
- **No admin portal.** Thirteen modules specified in PRD §13, all V1.
- **No Redis.** The workers are Postgres `SKIP LOCKED` sweeps, which is correct
  across replicas rather than correct once Redis arrives.
