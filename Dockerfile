# Food Court QR Ordering Platform — API and worker share one image.
# The process is selected at runtime by CMD, so API and worker can never
# drift to different code versions. Companion to Infrastructure & Operations §3.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependency layer, cached independently of source.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY contracts ./contracts
RUN npm run build           # tsc -> dist/

# Reinstall production-only, discarding dev dependencies.
RUN npm ci --omit=dev && npm cache clean --force

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    TZ=Asia/Kolkata

# dumb-init reaps zombies and forwards SIGTERM, which matters for graceful
# shutdown: BullMQ workers must finish the in-flight job, not be killed mid-refund.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY --from=build /app/contracts    ./contracts
COPY db/migrations                  ./db/migrations
COPY package.json                   ./

# Never run as root.
RUN useradd --system --uid 10001 --home /app appuser \
 && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

# Liveness only. Readiness is a separate endpoint that checks Postgres and Redis
# and must NOT be used for liveness, or a database blip restarts every pod.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
# Worker deployment overrides with:  ["node", "dist/workers/index.js"]
