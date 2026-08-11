# Infrastructure Technology

← [`tech.md`](../../tech.md) · Full detail in **Infrastructure & Operations v1.0** · Files: `Dockerfile`, `ci.yml`

This file is the _technology choices_. The operational procedures — alert
thresholds, runbooks, deploy windows, incident severities — live in the
Infrastructure & Operations document. Do not duplicate them here.

---

## The sizing fact that drives everything

Infra & Ops §1.1 derives the load model from first principles:

```
12 stalls · 400 orders/day · 60% in a 90-min lunch peak · 3x burst
  -> 8 orders/min at burst      = 0.13 writes/sec
  -> ~150 concurrent WebSockets per court
  -> test target 3x = 450 sockets, 24 orders/min
```

**This is a tiny system.** Two small API containers serve ten courts comfortably.
Every infrastructure choice below is therefore optimised for _operability by a
small team_, not for scale. Spend the complexity budget on correctness instead.

---

## Compute

| Component          | Choice                                                  | Pilot size         | Notes                                         |
| ------------------ | ------------------------------------------------------- | ------------------ | --------------------------------------------- |
| Container platform | **Managed** — ECS Fargate, Cloud Run or DO App Platform | —                  | Not Kubernetes. See rejections.               |
| API                | 2 replicas                                              | 1 vCPU / 2 GB each | Behind a managed LB with WebSocket stickiness |
| Worker             | 2 replicas, same image                                  | 1 vCPU / 2 GB each | `CMD` selects `dist/workers/index.js`         |
| Registry           | GHCR                                                    | —                  | Images tagged by commit SHA                   |

**One image, two deployments.** API and worker cannot drift to different code
versions — a worker processing an event shape the API no longer emits is a silent
data bug, and this makes it impossible.

### Container specifics (`Dockerfile`)

- `node:22-bookworm-slim`, multi-stage, prod-only `node_modules` in the final layer
- **`dumb-init` as PID 1** so `SIGTERM` actually reaches the process — a BullMQ
  worker killed mid-refund is precisely the failure this system must not have
- Non-root user (uid 10001)
- **Liveness and readiness are separate**: `/healthz` checks the event loop only;
  `/readyz` checks Postgres, Redis and the tax determination. Wiring readiness
  into liveness means a database blip restarts every container at once.
- Graceful shutdown: API drains 20 s, worker finishes the current job with a 60 s
  cap

---

## Managed services

| Service        | Choice                         | Pilot                    | Why managed                                                                           |
| -------------- | ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------- |
| PostgreSQL     | RDS / Cloud SQL / DO Managed   | 2 vCPU, 4 GB, 100 GB SSD | **This holds the ledger.** Automated backups and PITR are worth more than the saving. |
| Redis          | ElastiCache / Memorystore / DO | 1 GB, AOF on             | Cache and queue                                                                       |
| Object storage | S3-compatible                  | —                        | Menu images, QR assets                                                                |
| CDN            | CloudFront / Cloudflare        | —                        | PWA shell                                                                             |
| Load balancer  | Managed, TLS termination       | —                        | WebSocket sticky sessions                                                             |

Both data stores sit on a **private network with no public endpoint**. Access is
via bastion or the provider console only.

---

## Secrets

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| Store      | AWS Secrets Manager, GCP Secret Manager or Doppler                 |
| Loading    | Read at boot, held in memory                                       |
| Rotation   | Rolling restart. Acceptable at this scale.                         |
| Prohibited | `.env` files in the repo. Secrets in logs, URLs or client bundles. |

CI proves the last one: a job builds the web bundle and scans it for anything
secret-shaped (PRD SEC-03).

---

## CI/CD — GitHub Actions (`ci.yml`)

Organising rule: **every gate that protects money runs on every push.** Nothing
that protects money is a nightly job, because nightly jobs get muted.

| Job              | Gates                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static`         | Types, ESLint incl. module boundaries, OpenAPI lint, a grep that fails on floating point inside `pricing`/`payments`/`ledger`, requirement-ID existence check |
| `migrations`     | Apply from empty, then assert each PRD §18.3 violation fails **at the database**                                                                              |
| `test`           | Unit, property, integration, chaos. 95% line coverage floor on the three financial modules                                                                    |
| `security`       | `npm audit` high, gitleaks, client-bundle secret scan                                                                                                         |
| `a11y`           | axe-core across every PWA route; fails on serious or critical                                                                                                 |
| `image`          | Build and push, tagged by SHA                                                                                                                                 |
| `deploy-staging` | Migrate, deploy, smoke test                                                                                                                                   |

Production deploy is **manual**, behind an environment approval, and never during
a service window.

> **`test:chaos` is the job people will eventually want to delete.** It is slow
> and occasionally annoying. It is also the only automated proof that removing the
> vendor accept click was safe. If it is ever marked `continue-on-error`, the
> platform has quietly returned to the v4.0 risk profile.

---

## Observability

| Concern | Choice                         | Note                                                               |
| ------- | ------------------------------ | ------------------------------------------------------------------ |
| Metrics | Prometheus scrape → Grafana    | Managed Grafana Cloud is fine and removes a thing to run           |
| Logs    | Pino JSON → Loki or CloudWatch | Correlation id is an indexed label                                 |
| Errors  | Sentry                         | Correlation id + order id as tags                                  |
| Tracing | OpenTelemetry, 10% sampled     | 100% on payment and dispatch paths — that is where ambiguity lives |
| Uptime  | Better Stack                   | **Outside our own cloud**                                          |
| Paging  | PagerDuty / Opsgenie           | Page-severity only                                                 |

Thresholds are in Infra & Ops §5.2. Two of them should never fire at all —
`v_ledger_imbalance` and `v_credit_refund_conflict` returning any row means an
invariant was violated, not that a threshold needs tuning. **Do not tune them.
Fix the code.**

---

## Environments

| Env        | Data                                                                      | Deploy            | Provider keys               |
| ---------- | ------------------------------------------------------------------------- | ----------------- | --------------------------- |
| local      | Seeded (`npm run seed:pilot`)                                             | Docker Compose    | Stub with failure injection |
| ci         | Ephemeral per job                                                         | —                 | Stub                        |
| staging    | **Synthetic only** — never a production copy, it holds real phone numbers | Auto from `main`  | Sandbox                     |
| production | Real                                                                      | Manual + approval | Live                        |

---

## Cost

Indicative monthly, rupees, excluding tax. Planning figures, not quotes.

|                | Pilot (1 court)     | 10 courts           |
| -------------- | ------------------- | ------------------- |
| Postgres       | 3,000–5,000         | 8,000–14,000        |
| Redis          | 1,000–2,000         | 2,500–4,000         |
| Compute        | 3,000–5,000         | 8,000–15,000        |
| Storage + CDN  | 500–1,500           | 2,000–5,000         |
| Observability  | 0–4,000             | 6,000–12,000        |
| WhatsApp + SMS | ~2,000              | ~20,000             |
| **Total**      | **≈ 10,000–20,000** | **≈ 47,000–70,000** |

At ten mature courts that is roughly **4% of revenue**. Infrastructure is not the
constraint on this business; engineering salaries and time-to-200-orders-a-day
are (PRD §7.4).

---

## Rejected

| Rejected                         | Why                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kubernetes**                   | Four containers, 8 orders/min. K8s would be the most complex component in the system by an order of magnitude, and complexity nobody is on call for. Revisit past ~50 courts. |
| Self-hosted Postgres             | Saves a few thousand rupees a month and puts the ledger's backups in the hands of whoever last touched cron. The least interesting place to economise.                        |
| Serverless / Lambda for the API  | WebSockets, BullMQ workers and connection pooling all fight it.                                                                                                               |
| Terraform at pilot scale         | Real value at 5+ environments. At two, the console plus a documented setup is faster and less to maintain. Introduce it before the third court, not before the first.         |
| Separate API and worker images   | Invites version skew. One image, two commands.                                                                                                                                |
| Blue/green or canary             | Meaningful at scale. Here, a 60-second rollback of a two-container deployment is simpler and just as safe.                                                                    |
| Multi-region                     | One country, one timezone, lunch-hour traffic. Adds replication lag as a bug class for no availability gain that matters.                                                     |
| Prometheus + Grafana self-hosted | Another thing to run, patch and be paged about. Managed until the bill justifies it.                                                                                          |
