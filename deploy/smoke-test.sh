#!/usr/bin/env bash
# Post-deploy smoke test for the docker-compose production stack on EC2.
#
#   sudo ./deploy/smoke-test.sh
#
# Runs every check even after a failure, then exits non-zero if any failed, so a
# single run tells you everything that is broken rather than just the first thing.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# POSTGRES_USER / POSTGRES_DB normally come from the same .env docker compose reads.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

COMPOSE="docker compose -f docker-compose.prod.yml"
BASE_URL="${BASE_URL:-http://localhost:3000}"
EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS:-52}"

pass=0
fail=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_() {
  $COMPOSE exec -T postgres psql -U "${POSTGRES_USER:?set POSTGRES_USER}" \
    -d "${POSTGRES_DB:?set POSTGRES_DB}" -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

# ── 1. Containers ────────────────────────────────────────────────────────────
head_ "Containers"
for svc in postgres pgbouncer redis api nginx; do
  state=$($COMPOSE ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1==s{print $2}')
  case "$state" in
    running) ok "$svc is running" ;;
    "")      bad "$svc is not present" ;;
    *)       bad "$svc is '$state' (restarting = boot is still failing)" ;;
  esac
done

restarts=$(docker inspect -f '{{.RestartCount}}' soulzaa-api 2>/dev/null || echo "?")
sleep 20
restarts_after=$(docker inspect -f '{{.RestartCount}}' soulzaa-api 2>/dev/null || echo "?")
if [ "$restarts" = "$restarts_after" ]; then
  ok "api restart count stable at $restarts over 20s (no crash loop)"
else
  bad "api restarted during the check ($restarts -> $restarts_after) — still crash-looping"
fi

# ── 2. Schema ────────────────────────────────────────────────────────────────
head_ "Database schema"
applied=$(psql_ "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null;")
if [ "$applied" = "$EXPECTED_MIGRATIONS" ]; then
  ok "$applied migrations applied"
else
  bad "expected $EXPECTED_MIGRATIONS applied migrations, found '${applied:-none}'"
fi

failed=$(psql_ "select count(*) from _prisma_migrations where rolled_back_at is not null or (finished_at is null and started_at is not null);")
if [ "$failed" = "0" ]; then
  ok "no failed or rolled-back migrations"
else
  bad "$failed migration(s) in a failed state — run 'npx prisma migrate resolve' before redeploying"
fi

# One representative table per subsystem the deploy is supposed to bring up.
for t in treasury_reserves wallets gifts audio_rooms video_rooms game_sessions \
         treasure_boxes lucky_packets vip_memberships users; do
  if [ "$(psql_ "select to_regclass('public.$t') is not null;")" = "t" ]; then
    ok "table $t exists"
  else
    bad "table $t is MISSING"
  fi
done

# ── 3. HTTP ──────────────────────────────────────────────────────────────────
head_ "HTTP endpoints"
probe() { # probe <label> <path>
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL$2")
  if [ "$code" = "200" ]; then ok "$1 ($2) -> 200"; else bad "$1 ($2) -> $code"; fi
}
probe "liveness"  "/health/live"
probe "readiness" "/health/ready"     # exercises DB, Redis and every external dep
probe "startup"   "/health/startup"
probe "metrics"   "/metrics"

body=$(curl -s --max-time 15 "$BASE_URL/api/health/deep")
if printf '%s' "$body" | grep -q '"status":"ok"'; then
  ok "deep health check reports ok"
else
  bad "deep health check not ok: $(printf '%s' "$body" | head -c 300)"
fi

# ── 4. Socket.IO ─────────────────────────────────────────────────────────────
head_ "Socket.IO"
hs=$(curl -s --max-time 10 "$BASE_URL/socket.io/?EIO=4&transport=polling")
if printf '%s' "$hs" | grep -q '"sid"'; then
  ok "engine.io handshake returns a session id (gateways are mounted)"
else
  bad "engine.io handshake failed: $(printf '%s' "$hs" | head -c 200)"
fi

# Namespaces are negotiated after connect and are JWT-gated, so this only proves
# the server accepts the upgrade — per-namespace auth needs a real client token.
printf '  \033[33mNOTE\033[0m  namespaces (/audio-room /video-room /games /gifts /chat\n'
printf '        /call /notifications /live) need an authenticated client to verify\n'

# ── 5. Errors in recent logs ─────────────────────────────────────────────────
head_ "Recent logs"
errs=$($COMPOSE logs --tail=400 api 2>/dev/null | grep -cE 'PrismaClientKnownRequestError|P20[0-9]{2}|UnhandledPromiseRejection|Nest could not')
if [ "$errs" = "0" ]; then
  ok "no Prisma/Nest boot errors in the last 400 log lines"
else
  bad "$errs error line(s) in recent logs — inspect with: $COMPOSE logs --tail=100 api"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n\033[1mSummary:\033[0m %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
