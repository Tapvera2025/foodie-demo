#!/usr/bin/env bash
# Verifies graceful shutdown: SIGTERM must drain and exit cleanly.
# Infra & Ops INF-03. A worker killed mid-refund is the failure this prevents.
set -u

PORT="${PORT:-3996}"
LOG="$(mktemp)"

TAX_SECTION_9_5_APPLIES=true \
DATABASE_URL=postgres://x \
REDIS_URL=redis://x \
PORT="$PORT" \
  node dist/main.js > "$LOG" 2>&1 &
APP=$!

sleep 3
if ! kill -0 "$APP" 2>/dev/null; then
  echo "FAIL: process did not start"
  cat "$LOG"
  exit 1
fi
echo "started pid=$APP on port $PORT"

kill -TERM "$APP"
for i in $(seq 1 10); do
  sleep 1
  if ! kill -0 "$APP" 2>/dev/null; then
    wait "$APP" 2>/dev/null
    echo "PASS: exited ${i}s after SIGTERM"
    echo "--- log ---"
    cat "$LOG"
    exit 0
  fi
done

echo "FAIL: still running 10s after SIGTERM"
echo "--- log ---"
cat "$LOG"
kill -9 "$APP" 2>/dev/null
exit 1
