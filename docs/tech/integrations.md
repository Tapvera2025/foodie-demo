# Third-Party Integrations

← [`tech.md`](../../tech.md) · Derived from PRD v5.2 §4, §10, §14 · TDD v1.0 §5, §12

Every external service sits behind an adapter interface (PRD principle 6). No
domain module imports a vendor SDK. This file records which vendors we intend to
use and what each one costs us in lead time — which is usually the thing that
bites, not the code.

---

## Lead-time summary — start these in week 1–2

| Integration                      | Lead time         | Blocks              | Start by      |
| -------------------------------- | ----------------- | ------------------- | ------------- |
| Payment aggregator onboarding    | 1–3 weeks         | Week 5 of the build | **Week 1**    |
| WhatsApp BSP + template approval | 3–10 days         | Week 8              | **Week 2**    |
| SMS DLT registration (India)     | 1–3 weeks         | Week 8              | **Week 2**    |
| Petpooja partner access          | Unknown, external | Phase 3 only        | Opportunistic |

Nothing here is hard to code. Everything here is slow to obtain. The commonest
way this project slips is discovering in week 7 that a WhatsApp template is still
pending review.

---

## 1. Payments

**Not yet chosen** — PRD §31.1, gate week 4. Default assumption: **Razorpay Route**.

Everything goes through `PaymentProvider` (TDD §5.1), so the choice is reversible
at the cost of one adapter.

```ts
export interface PaymentProvider {
  readonly name: string;
  readonly mode: SettlementMode; // PLATFORM_COLLECT | VENDOR_DIRECT
  createIntent(input: CreateIntentInput): Promise<PaymentIntent>;
  getStatus(ref: string): Promise<ProviderPaymentStatus>;
  applySplit(input: SplitInput): Promise<SplitResult>; // no-op in Mode B
  refund(input: RefundInput): Promise<RefundResult>;
  verifyAndParseWebhook(raw: Buffer, headers: Headers): NormalisedPaymentEvent;
  getSettlementReport(period: DateRange): Promise<SettlementReport | null>;
}
```

### Selection criteria (PRD §4.6)

Verify each against **live documentation and a sandbox call**, not a sales deck.

- [ ] Split settlement with linked sub-merchant accounts
- [ ] Splits work on **UPI** specifically, not only cards
- [ ] Programmatic sub-merchant KYC onboarding (dashboard-only will not scale)
- [ ] Refund with **transfer reversal** — or the platform absorbs every refund
- [ ] Partial refund support
- [ ] Webhook signature verification with replay protection
- [ ] Idempotency on transfer creation
- [ ] Machine-readable settlement report
- [ ] UPI Reserve Pay (single-block-multi-debit) — desirable, not required
- [ ] **Sandbox can simulate a failed refund, a delayed webhook and a duplicate
      webhook.** If it cannot, failure testing is theatre.

### Implementation notes

- **SDK vs raw HTTP:** prefer raw HTTP through our own `undici` wrapper. Provider
  SDKs bury retry behaviour and make idempotency keys hard to control. We need
  both explicit.
- **Split timing is `ON_ACKNOWLEDGED`** by default (TDD §5.2). Creating transfers
  at capture means every rejection needs a reversal; creating them after the
  kitchen has the order means the common rejection case needs none.
- **Webhook order of operations is fixed**: verify signature → insert
  `processed_event` (catch unique violation → 200 and drop) → handle. Never parse
  an unverified body.
- **`kind: UNKNOWN` is never `FAILED`.** It opens a reconciliation item and
  returns 200 so the provider stops retrying.

---

## 2. WhatsApp — the iOS answer

Tier 3 of the notification ladder, and in practice the **primary out-of-app
channel** because Web Push does not work on uninstalled iOS PWAs.

|            |                                                                |
| ---------- | -------------------------------------------------------------- |
| Access     | Meta Cloud API via a BSP                                       |
| Candidates | AiSensy, Gupshup, Interakt, Wati                               |
| Cost       | ~₹0.115 per utility message + 18% GST ≈ **₹0.14**              |
| Per order  | 2 messages (confirmed, ready) ≈ ₹0.28                          |
| Templates  | 4 required — see Screens & Copy → Notifications sheet          |
| Consent    | Opt-in captured at checkout with timestamp and wording version |

**Submit templates in week 2.** Approval is measured in days, is occasionally
rejected for wording, and is on the critical path for week 8.

Choose a BSP on: template approval turnaround, webhook reliability for delivery
receipts (we record delivered vs sent per PRD NOTIF-02), and whether they resell
at Meta list price or mark it up.

---

## 3. SMS — tier 4 fallback

|                      |                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Candidates           | MSG91, Kaleyra, Twilio                                                                      |
| Cost                 | ₹0.15–0.25 per message                                                                      |
| Volume               | ~10% of orders (WhatsApp failure or number not on WhatsApp)                                 |
| **DLT registration** | Mandatory in India. Entity + sender ID + template, each approved separately. **1–3 weeks.** |

DLT is the hidden lead time. Register the entity, the header and every template
in week 2. An unregistered template is silently dropped by the operator, which is
the worst possible failure mode for a "your food is ready" message.

---

## 4. Thermal printing

Not a third-party service, but an external device with its own failure modes.

|          |                                                                              |
| -------- | ---------------------------------------------------------------------------- |
| Library  | `node-thermal-printer`                                                       |
| Protocol | ESC/POS over TCP port 9100                                                   |
| Paper    | 80mm, 48 columns Font A; 58mm/32-column fallback                             |
| Encoding | CP437. Transliterate at import — do not attempt Devanagari on a generic head |
| Layout   | Interface Specs §3.2                                                         |

**A print failure must not acknowledge** (PRD KDS-PR-03). Paper-out is
indistinguishable from no kitchen, so the escalation ladder must fire. Poll
printer status before dispatch where the model supports it; treat paper-out and
cover-open as offline.

Prefer network printers over a USB bridge. A bridge adds a Windows machine nobody
maintains to the order path.

---

## 5. POS — Petpooja (Phase 3, deferred)

Deliberately **not** in the pilot (PRD correction #11). Partner onboarding is an
external dependency on a schedule we do not control, and the pilot proves nothing
about it.

The adapter contract is written now (TDD §12) so nothing is rebuilt later:

```ts
export interface PosAdapter {
  fetchMenu(v: VendorRef): Promise<NormalisedMenu>;
  pushOrder(i: PushOrderInput): Promise<PushOrderResult>; // idempotent on platform order id
  getOrderStatus(externalId: string): Promise<PosOrderStatus>;
  syncStock(v: VendorRef): Promise<StockSnapshot>;
  cancelOrder(externalId: string, reason: string): Promise<CancelResult>;
  verifyAndParseWebhook(raw: Buffer, headers: Headers): NormalisedPosEvent;
}
```

Known Petpooja shape: app key + app secret + access token, scoped by restaurant
id; menu fetch with categories, items, variations, add-on groups, attributes and
taxes; a push-menu callback on catalogue change; order push; order-status
callbacks to a supplied URL; item and store availability toggles.

**Confirm every capability in a sandbox before Phase 3 planning.** Treat anything
not demonstrated as unavailable.

The platform KDS is itself an implementation of `PosAdapter` — which is how we
know the abstraction is honest rather than aspirational.

---

## 6. Supporting services

| Service        | Choice                            | Purpose                                                                                      |
| -------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| Object storage | S3 or DigitalOcean Spaces         | Menu images, QR assets                                                                       |
| CDN            | CloudFront or Cloudflare          | PWA shell + images                                                                           |
| Error tracking | Sentry                            | Correlation id + order id as tags                                                            |
| Metrics & logs | Grafana Cloud (Prometheus + Loki) | Free tier covers the pilot                                                                   |
| Uptime         | Better Stack                      | **External** synthetic check — from outside our own cloud, or a regional outage is invisible |
| On-call        | PagerDuty or Opsgenie             | Only page-severity alerts route here                                                         |

---

## Integration rules

Apply to every adapter without exception (PRD §14.1, §23):

1. Every external call carries a correlation id and is logged with duration and outcome.
2. Every write is idempotent on a **platform-generated** key.
3. Every webhook is signature-verified **before** the body is parsed, and idempotent on provider event id.
4. Retries use exponential backoff **with jitter**.
5. A timeout is an unknown — never proof of failure or success. Verify, or reconcile.
6. External status never forces an invalid local transition.
7. Terminal failure lands in a visible queue with an owner. Nothing disappears.
8. Credentials come from the secret store and never reach a client bundle or a log.
