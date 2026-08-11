#!/usr/bin/env bash
#
# Works out which Postgres you are actually talking to.
#
#   bash scripts/db-doctor.sh
#
# Exists because "authentication failed" on localhost:5432 is almost always a
# port collision: a Homebrew or Postgres.app server already owns 5432, so the
# Docker container is healthy and simultaneously not the thing you reach.

set -uo pipefail
BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$OFF"; }

step "What is listening on 5432?"
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:5432 -sTCP:LISTEN 2>/dev/null | tail -n +1 | grep -q .; then
    lsof -nP -iTCP:5432 -sTCP:LISTEN 2>/dev/null | sed 's/^/     /'
  else
    echo "     nothing"
  fi
else
  echo "     (lsof not available)"
fi

step "Homebrew services"
if command -v brew >/dev/null 2>&1; then
  brew services list 2>/dev/null | grep -i postgres | sed 's/^/     /' || echo "     no postgres service"
else
  echo "     brew not installed"
fi

step "Docker containers publishing 5432"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker ps --format '     {{.Names}}  {{.Image}}  {{.Ports}}' | grep -i 5432 || echo "     none"
else
  echo "     docker not running"
fi

step "Trying each candidate connection"
try() {
  local label="$1" url="$2"
  printf '     %-46s ' "$label"
  if out=$(node -e '
    const pg=require("pg");
    const p=new pg.Pool({connectionString:process.argv[1],connectionTimeoutMillis:3000});
    p.query("SELECT current_user, current_database(), version()")
      .then(r=>{const v=r.rows[0];console.log(`${v.current_user}@${v.current_database} | ${v.version.split(" ").slice(0,2).join(" ")}`);return p.end();})
      .catch(e=>{console.error(e.code||e.message);process.exit(1);});
  ' "$url" 2>&1); then
    printf '%sOK%s  %s\n' "$GREEN" "$OFF" "$out"
    echo "$url" >> /tmp/.fc_working_urls
  else
    printf '%s--%s  %s\n' "$RED" "$OFF" "$out"
  fi
}

rm -f /tmp/.fc_working_urls
try "docker compose creds (foodcourt:foodcourt)" "postgres://foodcourt:foodcourt@localhost:5432/foodcourt?sslmode=disable"
try "your macOS user, foodcourt db"              "postgres://$(whoami)@localhost:5432/foodcourt?sslmode=disable"
try "your macOS user, postgres db"               "postgres://$(whoami)@localhost:5432/postgres?sslmode=disable"
try "docker on an alternate port 5433"           "postgres://foodcourt:foodcourt@localhost:5433/foodcourt?sslmode=disable"

step "Verdict"
if [ -s /tmp/.fc_working_urls ]; then
  WORKING=$(head -1 /tmp/.fc_working_urls)
  echo "     At least one connection works. Use it:"
  echo
  printf '       %sDATABASE_URL=%s npm run verify:db%s\n' "$BOLD" "$WORKING" "$OFF"
  echo
  if grep -q "$(whoami)@" <<<"$WORKING" && docker ps --format '{{.Ports}}' 2>/dev/null | grep -q 5432; then
    printf '     %sNote:%s your own Postgres answers on 5432, so the Docker container is\n' "$RED" "$OFF"
    echo "     running but unreachable — the port was already taken. You do not need"
    echo "     both. Either stop the local one:"
    echo "       brew services stop postgresql@16"
    echo "     or stop the container and just use the local server:"
    echo "       docker compose down"
  fi
else
  echo "     Nothing answered. Start one:"
  echo "       brew install postgresql@16 && brew services start postgresql@16 && createdb foodcourt"
  echo "     or"
  echo "       docker compose up -d"
fi
rm -f /tmp/.fc_working_urls
echo
