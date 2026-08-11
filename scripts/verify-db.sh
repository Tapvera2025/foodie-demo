#!/usr/bin/env bash
#
# One command to prove the schema is real.
#
#   npm run verify:db
#
# Applies the migration from empty, then asserts that every PRD §18.3 rule is
# enforced by the DATABASE rather than by application code.
#
# Docker is OPTIONAL. If DATABASE_URL already points at a reachable Postgres 16
# — Homebrew, Postgres.app, a cloud instance — this uses it and never touches
# Docker. Docker is one way to obtain a Postgres, not the point of the exercise.
#
# Infra & Ops §4 (job: migrations). This is the check CI runs on every push.

set -uo pipefail

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$OFF"; }
fail() { printf '\n%s FAIL %s %s\n\n' "$RED" "$OFF" "$1"; exit 1; }
ok()   { printf '%s  ok %s %s\n' "$GREEN" "$OFF" "$1"; }
mask() { sed 's|://[^@]*@|://***@|' <<<"$1"; }

# A .env in the project root wins over the built-in default, so nobody has to
# retype a connection string they already worked out.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
export DATABASE_URL="${DATABASE_URL:-postgres://foodcourt:foodcourt@localhost:5432/foodcourt?sslmode=disable}"

# Returns 0 and prints "user@database" if DATABASE_URL is reachable.
probe() {
  node -e '
    const pg = require("pg");
    const p = new pg.Pool({ connectionString: process.argv[1], connectionTimeoutMillis: 4000 });
    p.query("SELECT current_user, current_database(), current_setting($1) AS v", ["server_version"])
      .then((r) => { const x = r.rows[0]; console.log(`${x.current_user}@${x.current_database} (PostgreSQL ${x.v})`); return p.end(); })
      .catch((e) => { console.error(e.code || e.message); process.exit(1); });
  ' "$DATABASE_URL" 2>&1
}

# ---------------------------------------------------------------- prerequisites
step "Checking prerequisites"
command -v node >/dev/null || fail "node is not installed"
ok "node $(node -v)"
[ -d node_modules ] || { step "Installing dependencies"; npm ci || fail "npm ci failed"; }
ok "dependencies present"

# ------------------------------------------------------------------- a database
step "Looking for a Postgres"
printf '     %s\n' "$(mask "$DATABASE_URL")"

if WHO=$(probe); then
  ok "connected as $WHO"
  printf '     %s(already reachable — not starting Docker)%s\n' "$DIM" "$OFF"
else
  printf '     not reachable yet: %s\n' "$WHO"

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    COMPOSE="docker compose"; docker compose version >/dev/null 2>&1 || COMPOSE="docker-compose"
    step "Starting Postgres and Redis with Docker"
    # A warning, not a failure: if compose cannot start we still fall through
    # to the probe, because the port may already be served by something else.
    $COMPOSE up -d || printf '     %sdocker compose up failed — continuing anyway%s\n' "$DIM" "$OFF"
    printf '     waiting'
    for _ in $(seq 1 45); do
      printf '.'
      sleep 1
      if WHO=$(probe); then printf '\n'; ok "connected as $WHO"; break; fi
    done
  fi

  if ! WHO=$(probe); then
    printf '\n%s FAIL %s cannot reach a Postgres on that URL.\n\n' "$RED" "$OFF"
    echo "  If a container is running but unreachable, another Postgres probably"
    echo "  already owns the port. Find out which:"
    echo
    printf '    %snpm run db:doctor%s\n\n' "$BOLD" "$OFF"
    exit 1
  fi
fi

# ---------------------------------------------------------------------- migrate
step "Applying migrations from empty"
npx tsx scripts/migrate.ts up || fail "migration did not apply — see the error above"
ok "migration applied"

step "Checking what was created"
node -e '
const pg = require("pg");
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const q = async (sql) => (await p.query(sql)).rows[0].n;
  const tables  = await q("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=current_schema() AND table_type=\x27BASE TABLE\x27");
  const enums   = await q("SELECT count(DISTINCT t.typname)::int n FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid");
  const indexes = await q("SELECT count(*)::int n FROM pg_indexes WHERE schemaname=current_schema()");
  const trigs   = await q("SELECT count(*)::int n FROM information_schema.triggers WHERE trigger_schema=current_schema()");
  const views   = await q("SELECT count(*)::int n FROM information_schema.views WHERE table_schema=current_schema()");
  console.log(`     tables ${tables} · enums ${enums} · indexes ${indexes} · triggers ${trigs} · views ${views}`);
  let bad = 0;
  const want = { tables: 31, enums: 24, views: 4 };   // 30 + schema_migrations
  if (tables < want.tables) { console.error(`     expected at least ${want.tables} tables`); bad++; }
  if (enums  < want.enums)  { console.error(`     expected at least ${want.enums} enums`);  bad++; }
  if (views  < want.views)  { console.error(`     expected at least ${want.views} views`);  bad++; }
  await p.end();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("     " + e.message); process.exit(1); });
' || fail "the schema is missing objects it should have"
ok "schema looks complete"

# ------------------------------------------------------------------ constraints
step "Asserting constraints are enforced by the DATABASE"
npx tsx scripts/test-constraints.ts || fail "one or more constraints are not enforced"

# ------------------------------------------------------------------- idempotent
step "Re-running migrations (must be a no-op)"
npx tsx scripts/migrate.ts up || fail "re-running migrations failed — they are not idempotent"
ok "migrations are idempotent"

printf '\n%sALL DATABASE CHECKS PASSED%s\n\n' "$GREEN$BOLD" "$OFF"
