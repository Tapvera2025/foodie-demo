# Tooling & Testing

← [`tech.md`](../../tech.md) · Derived from TDD v1.0 §17 · PRD v5.2 §27

---

## Repository

Single repo, npm workspaces. No Nx, no Turborepo — at this size they add
configuration without saving time.

```
├── tech.md                     # stack decisions (this tree)
├── docs/tech/                  # per-layer detail
├── contracts/openapi.yaml      # authoritative wire contract
├── db/migrations/*.sql         # authoritative schema
├── apps/{pwa,kds,console}/     # Vite build targets
├── src/                        # backend modules (TDD §2.2)
├── workers/                    # BullMQ processors
├── scripts/                    # seed, codegen, deploy, checks
└── tests/{integration,e2e,load}/
```

| Tool             | Choice               | Note                                                                                                                   |
| ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Package manager  | **npm** 10+          | `npm ci` everywhere. Matches the shipped `ci.yml`. pnpm is fine but would require editing CI — decide once, not twice. |
| Node version pin | `.nvmrc` + `engines` | 22 LTS                                                                                                                 |
| Monorepo         | npm workspaces       | Sufficient                                                                                                             |

---

## Code quality

| Tool                           | Version         | Enforces                                                           |
| ------------------------------ | --------------- | ------------------------------------------------------------------ |
| TypeScript                     | 5.6+            | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| ESLint                         | 9 (flat config) | Correctness rules, not style                                       |
| **`eslint-plugin-boundaries`** | 5               | **Module dependency direction from TDD §2.1**                      |
| `eslint-plugin-jsx-a11y`       | 6               | Frontend accessibility                                             |
| Prettier                       | 3               | Formatting. Never argued about.                                    |
| Husky + lint-staged            | —               | Pre-commit: format + lint changed files only                       |

### The boundary rule is the important one

TDD §2.1 defines a strict dependency direction. Without enforcement it erodes in
about six weeks. Encoded as config:

```js
// eslint.config.js — excerpt
{
  settings: {
    'boundaries/elements': [
      { type: 'platform', pattern: 'src/platform/*' },
      { type: 'pricing',  pattern: 'src/pricing/*'  },
      { type: 'ordering', pattern: 'src/ordering/*' },
      { type: 'payments', pattern: 'src/payments/*' },
      { type: 'realtime', pattern: 'src/realtime/*' },
      // ...
    ],
  },
  rules: {
    'boundaries/element-types': ['error', {
      default: 'disallow',
      rules: [
        // pricing is PURE: it may import nothing but the money type.
        { from: 'pricing',  allow: ['platform'] },
        { from: 'ordering', allow: ['platform', 'pricing', 'cart', 'tenancy'] },
        { from: 'payments', allow: ['platform', 'pricing', 'ordering'] },
        // realtime may READ ordering and nothing else.
        { from: 'realtime', allow: ['platform', 'ordering'] },
      ],
    }],
    // No domain module may import a provider SDK directly (PRD PAY-MODE-02).
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['razorpay', 'cashfree*', '**/providers/*'],
        message: 'Use the PaymentProvider interface. See docs/tech/backend.md.',
      }],
    }],
  },
}
```

---

## Testing

| Layer               | Tool                        | What it proves                                                      |
| ------------------- | --------------------------- | ------------------------------------------------------------------- |
| Unit                | **Vitest** 2                | Pricing arithmetic, transition guards, idempotency, tax computation |
| Property            | **fast-check** 3            | Ledger entries sum to zero for _any_ legal fee config               |
| Integration         | Vitest + **Testcontainers** | Real Postgres and Redis. Webhooks, locks, constraints.              |
| HTTP                | `supertest`                 | Contract conformance against `openapi.yaml`                         |
| E2E                 | **Playwright** 1.4x         | Full checkout on real browser engines                               |
| Accessibility       | `@axe-core/playwright`      | WCAG 2.2 AA, fails on serious/critical                              |
| Load                | **k6**                      | 3× the Infra & Ops §1.1 model                                       |
| Provider simulation | In-repo stub                | Delayed, duplicate and unrecognised webhooks on demand              |

### Non-negotiables

**Testcontainers, not mocks, for the database.** Half the guarantees in this
system are database constraints (PRD §18.3). A mocked repository proves the
application would have been fine if the database behaved as imagined. Run the
real thing.

**Property tests are mandatory for `pricing` and `ledger`.** The single most
valuable test in the repo:

```ts
test.prop([arbCart(), arbFeeConfig(), arbTaxModel()])(
  'ledger entries always sum to zero',
  (cart, fees, tax) => {
    const quote = computeQuote(cart, fees, tax); // pure — no I/O
    const entries = ledgerEntriesFor(quote);
    expect(sum(entries.debits)).toBe(sum(entries.credits));
  },
);
```

**Seed with `section9_5Applies = true`.** The harder tax path should be the
default in development and CI, so nobody discovers it in week 9.

### The chaos suite gates auto-fulfil

TDD §17.1. These are the tests that make removing the vendor accept click
defensible. None may be skipped or marked flaky:

- KDS network killed immediately after payment → ladder fires at 15/45/90/180 s
- Printer out of paper, KDS alive → single-target ack is sufficient
- Both dispatch targets dead → `DISPATCH_FAILED`, refund path exercised
- Device acknowledges at 179 s → ladder cancels, no cancel offer shown
- Backend restarted mid-ladder → resumes from persisted state
- Duplicate payment webhook → exactly one order, one dispatch, one ledger set
- Credit consumed while refund in flight → `v_credit_refund_conflict` stays empty

---

## Code generation

```bash
npm run codegen:api     # openapi-typescript  contracts/openapi.yaml -> src/generated/api.d.ts
npm run codegen:i18n    # copy deck xlsx      -> apps/*/locales/en-IN.json
```

Direction matters: types flow **from** the contract into code, never the
reverse. The spec is the source of truth.

**There used to be a third — `codegen:db`, via `kysely-codegen` — and it is
gone.** Two reasons, the second being the general one:

1. `kysely-codegen` was never in `devDependencies`. The script could not have
   run on any clean checkout, and had not. `src/platform/db.ts` still held
   `export interface Database {}`, an empty interface, so Kysely knew about no
   tables at all.
2. Generation only protects you at the moment somebody runs it. Between that
   moment and the next, the types and the database drift and the compiler
   cannot object, because the generated types *are* its only notion of truth —
   there is no second opinion available to it.

Database types now live in `src/platform/schema.ts`, maintained by hand, and
`tests/integration/schema-conformance.test.ts` supplies the second opinion: it
reads `information_schema` from a real Postgres and fails on any disagreement
about a column, its nullability, a missing `Generated<>`, or an enum widened to
`string`. That runs on every push against the CI Postgres service, so drift is
caught on the commit that causes it rather than whenever someone next reruns a
tool. See `docs/errata.md` E-005.

---

## Local development

```bash
cp .env.example .env          # TAX_SECTION_9_5_APPLIES must be set or nothing boots
docker compose up -d          # postgres, redis, mailpit, stub payment provider
npm ci
npm run migrate:up
npm run seed:pilot            # 1 court, 12 tables, 6 vendors, ~240 items
npm run dev                   # api + worker + 3 vite targets
```

`seed:pilot` deliberately includes the awkward cases (TDD §17.2): one vendor with
a dead heartbeat, one with no printer, four Mode A and two Mode B, and a stub
provider that can inject latency, failures and duplicate webhooks.

QR codes for the seeded tables are written to `./tmp/qr/` so you can scan them
off your own screen.

---

## Scripts that are part of CI, not conveniences

| Script                               | Purpose                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `scripts/check-req-ids.js`           | Every `REQ:` comment in code names a requirement that exists |
| `scripts/scan-bundle-for-secrets.js` | Nothing secret-shaped reachable from the client bundle       |
| `npm run test:constraints`           | Each PRD §18.3 violation fails at the **database**           |
| `npm run test:chaos`                 | The suite above                                              |

---

## Rejected

| Rejected                                  | Why                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jest                                      | Vitest is faster, TS-native, and shares config with Vite. No reason to run two toolchains.                                                           |
| Nx / Turborepo                            | Configuration overhead exceeding the benefit at this size.                                                                                           |
| pnpm                                      | Genuinely better, but `ci.yml` already ships with `npm ci`. Consistency beats marginal speed. Revisit only if install time becomes a real complaint. |
| Cypress                                   | Playwright has better multi-engine support, and we specifically need real WebKit for the iOS notification behaviour.                                 |
| Mocked database in integration tests      | Would test our imagination of Postgres rather than Postgres.                                                                                         |
| Storybook                                 | Worth it past ~40 components. We have 18, heavily context-specific.                                                                                  |
| 100% coverage target                      | Drives tests of trivia. 95% on `pricing`/`payments`/`ledger` and judgement elsewhere.                                                                |
| Commit-message linting / semantic-release | A monolith with no published package gains nothing from it.                                                                                          |
