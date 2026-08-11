# Backend Technology

← [`tech.md`](../../tech.md) · Derived from TDD v1.0 §2–§9 · Interface Specs v1.0 §2

One deployable, two processes from **one image** (`Dockerfile`): the API and the
BullMQ worker. They can never drift to different code versions, which matters
because a worker processing an event shape the API no longer emits is a silent
data bug.

---

## Core

| Concern          | Choice                                 | Version | Why                                                                                    |
| ---------------- | -------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Runtime          | Node.js                                | 22 LTS  | Matches `Dockerfile`. Native `fetch`, stable test runner, good perf.                   |
| Language         | TypeScript                             | 5.6+    | `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.              |
| Framework        | NestJS                                 | 11      | Modules and DI map 1:1 onto TDD §2.1. Boundaries become structural, not conventional.  |
| HTTP adapter     | Express                                | 5       | Best-supported Nest adapter. At 8 orders/min, Fastify's throughput edge is irrelevant. |
| Validation       | Zod                                    | 3       | Shared shapes with the frontend. Parses at the boundary, never inside domain code.     |
| Realtime         | Socket.IO + `@socket.io/redis-adapter` | 4       | Multi-instance broadcast. **Broadcast only** — never a source of state.                |
| Queue            | BullMQ                                 | 5       | Retries, backoff with jitter, delayed jobs, DLQ. Powers the escalation ladder.         |
| Logging          | Pino + `nestjs-pino`                   | 9       | Structured JSON. Correlation id from `AsyncLocalStorage`.                              |
| Metrics          | `prom-client`                          | 15      | `/metrics`, private network only.                                                      |
| Tracing          | OpenTelemetry SDK                      | 1.x     | 10% sample; 100% on payment and dispatch paths.                                        |
| Errors           | `@sentry/node`                         | 8       | Correlation id and order id as tags.                                                   |
| JWT              | `jose`                                 | 5       | EdDSA. No algorithm-confusion history.                                                 |
| Password hashing | `argon2`                               | 0.41    | Argon2id. Staff logins only.                                                           |
| HTTP client      | native `fetch` + `undici`              | —       | With a shared retry/backoff wrapper. No axios.                                         |
| Dates            | `date-fns` + `date-fns-tz`             | 4       | UTC storage; court timezone for display only.                                          |
| CSV              | `csv-parse`                            | 5       | Menu import (Interface Specs §4). Streaming, strict.                                   |
| QR generation    | `qrcode`                               | 1.5     | **Must** be configured `errorCorrectionLevel: 'H'` (Interface Specs §5.1).             |
| PDF              | `pdfkit`                               | 0.15    | A4 QR imposition sheets.                                                               |
| Thermal print    | `node-thermal-printer`                 | 4       | ESC/POS over TCP 9100.                                                                 |

---

## Why NestJS

The one real decision here. The alternative was bare Express with a hand-rolled
structure.

TDD §2.1 defines 15 modules with a **strict dependency direction** — `pricing`
depends on nothing, `realtime` may only read, `ordering` may not import a payment
SDK. Nest makes that structural: modules declare their imports, and a violation
is a compile-time or bootstrap error rather than a code-review opinion.

Backed up by `eslint-plugin-boundaries` (see [`tooling.md`](tooling.md)), a
violation fails CI.

The cost is decorators and a learning curve. Accepted. The thing we are
protecting is a modular monolith that must stay modular for two years without a
principal engineer policing every PR.

---

## Module layout

Mirrors TDD §2.1 exactly.

```
src/
  platform/    money.ts  correlation.ts  errors.ts  config.ts  logger.ts
  identity/    rbac.ts  permissions.ts  tokens.ts
  tenancy/     food-court  vendor  qr  device
  catalog/     menu  availability  import
  cart/        cart  option-validator
  pricing/     quote.ts  fee-engine.ts  tax-model.ts  rounding.ts   <-- PURE
  ordering/    order.service  state-machine  commands/
  payments/    provider.interface  providers/  webhook  refund  credit
  ledger/      ledger  settlement  reconciliation/
  dispatch/    dispatch  escalation.worker  printer.adapter
  notify/      ladder  channels/{websocket,webpush,whatsapp,sms}
  realtime/    gateway.ts                                          <-- READ ONLY
  console/     manager/  admin/
  pos/         adapter.interface  petpooja/                        <-- Phase 3
  analytics/   events.ts
workers/       index.ts
```

### Two boundaries that are not style preferences

**`pricing` is pure.** No database, no clock, no network, no Nest injection of
anything stateful. It takes a cart, a fee rule set and a tax model, and returns a
quote. This is what makes the arithmetic property-testable (TDD §4.3) and it is
why the ledger balance invariant can be proven rather than hoped for.

**`realtime` never writes.** It subscribes to committed domain events and
broadcasts. A socket handler that needs to change state calls an `ordering`
command like any other caller (PRD principle 9).

---

## Configuration

Zod-validated at boot. The process must not start with an invalid config.

```ts
const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // TDD §14: NO DEFAULT. A boolean defaulting to false is how a platform
  // silently overpays every vendor by the full food GST.
  TAX_SECTION_9_5_APPLIES: z.enum(['true', 'false']).transform((v) => v === 'true'),
  PAYMENTS_PROVIDER: z.enum(['razorpay-route', 'vendor-direct', 'stub']),
  PAYMENTS_SPLIT_TIMING: z.enum(['ON_CAPTURE', 'ON_ACKNOWLEDGED']).default('ON_ACKNOWLEDGED'),
  // ... see Infra & Ops for the full inventory
});
```

`/readyz` re-asserts the tax determination is set, so a misconfigured container
never receives traffic.

---

## Error model

One shape, everywhere. Clients branch on `code`, never on message or status alone.
Full catalogue in TDD §15.

```ts
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode, // 'VENDOR_DEVICE_OFFLINE' | 'INVALID_TRANSITION' | ...
    readonly httpStatus: number,
    readonly detail?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(code);
  }
}
```

A Nest exception filter renders it as the `Problem` schema in `openapi.yaml` and
attaches the correlation id. Unhandled errors become `500` with a correlation id
and nothing else — never a stack trace, never a database message.

---

## API contract is spec-first

`contracts/openapi.yaml` is authoritative. Types flow **from** it.

```bash
npm run codegen:api      # openapi-typescript -> src/generated/api.d.ts
```

- Handlers are typed against generated types. A handler returning a shape the
  spec does not describe is a type error.
- Requests are validated against the spec at the edge (`express-openapi-validator`).
- CI lints the spec (`@redocly/cli`) and fails on drift.
- **Do not** use Nest's Swagger decorators to generate the spec. That inverts the
  dependency and lets the implementation quietly redefine the contract.

---

## Idempotency

One helper, used by every money-moving path (TDD §3.3). The guarantee is the
**database unique constraint** — the application check is only a fast path.

| Operation        | Key                                                                 |
| ---------------- | ------------------------------------------------------------------- |
| Order creation   | Client `Idempotency-Key` header → `order.idempotency_key`           |
| Payment intent   | Platform order id → `payment.order_id`                              |
| Provider webhook | Provider event id → `processed_event (provider, provider_event_id)` |
| Refund           | Platform refund id, generated _before_ the provider call            |
| Split transfer   | Platform transfer id                                                |
| Credit issue     | Origin order id → `platform_credit.origin_order_id`                 |

---

## Auth

Interface Specs §2. Three token types, one issuer.

| Token                      | Lifetime | Refresh                           | Library note                    |
| -------------------------- | -------- | --------------------------------- | ------------------------------- |
| Session (customer)         | 4 h      | Silent while unexpired            | Anonymous. No PII in claims.    |
| Device (KDS/printer/board) | 30 d     | Rotating, rides the heartbeat     | Scoped to **one** vendor.       |
| Staff                      | 30 min   | Single-use rotating refresh, 12 h | Reuse revokes the whole family. |

Revocation is by `token_version` bump, not a distributed blocklist — a counter
column compared against a claim. Deactivating a device stops it within one
heartbeat interval, at most 15 seconds.

**Claims never widen access.** Tenant scope is re-resolved server-side on every
request. A forged `fc` claim gets a 404 and a log line.

---

## Rejected

| Rejected                                         | Why                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Bare Express                                     | Nothing structurally prevents module boundary erosion.                                              |
| Fastify adapter                                  | Real throughput advantage, zero relevance at this load, slightly thinner Nest ecosystem support.    |
| tRPC                                             | Three heterogeneous clients including devices; we need a language-neutral published contract.       |
| `axios`                                          | Native `fetch` plus `undici` covers it. One less dependency in the payment path.                    |
| `jsonwebtoken`                                   | Superseded by `jose`.                                                                               |
| `class-validator`                                | Zod is already shared with the frontend; two validation systems is one too many.                    |
| Nest Swagger decorators                          | Inverts spec-first. The contract must not be a side effect of the code.                             |
| In-memory `setTimeout` for the escalation ladder | PRD ESC-01 requires durability. A restart must not lose an escalation. BullMQ delayed jobs, always. |
