#!/usr/bin/env bash
# Owns only a disposable loopback PostgreSQL/Redis pair. Never sources a .env.
set -euo pipefail
[[ $# -gt 0 ]] || { echo 'usage: with-native-test-services.sh COMMAND [ARGS...]' >&2; exit 64; }
repo="$(cd "$(dirname "$0")/.." && pwd)"
root="$repo/.superpowers/tools/native18/root"
pg="$root/usr/lib/postgresql/18/bin"
export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
[[ -x "$pg/initdb" && -x "$root/usr/bin/redis-server" ]] || { echo 'Native test tools missing' >&2; exit 69; }
exec 9>/tmp/ai-ecosystem-build.lock
flock -w 900 9 || exit 75
python3 - <<'CHECK'
import socket
for port in (15432, 16379):
 with socket.socket() as sock:
  # Reuse only TIME_WAIT from our closed test server, never an active listener.
  sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
  sock.bind(('127.0.0.1', port))
CHECK
owned="$(mktemp -d /tmp/aiag-native-review.XXXXXXXX)"
chmod 700 "$owned"
pg_started=0
redis_pid=''
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [[ -n "$redis_pid" ]] && kill -0 "$redis_pid" 2>/dev/null; then kill -TERM "$redis_pid"; wait "$redis_pid" 2>/dev/null || true; fi
  if [[ "$pg_started" == 1 ]]; then "$pg/pg_ctl" -D "$owned/data" -m fast -w stop >>"$owned/postgres.log" 2>&1 || result=1; fi
  if [[ -f "$owned/data/postmaster.pid" ]]; then echo "Cleanup incomplete: $owned" >&2; result=1
  else
    mkdir -p "$repo/.superpowers/sdd/2026-09-28-release-remediation"
    cp "$owned/postgres.log" "$repo/.superpowers/sdd/2026-09-28-release-remediation/native-postgres.log" 2>/dev/null || true
    rm -rf -- "$owned"
    echo 'Owned PostgreSQL/Redis stopped; disposable data removed.'
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$pg/initdb" -D "$owned/data" -L "$root/usr/share/postgresql/18" -U aiag_test --no-locale -E UTF8 -A trust >"$owned/init.log" 2>&1
"$pg/pg_ctl" -D "$owned/data" -l "$owned/postgres.log" -o "-h 127.0.0.1 -p 15432 -k $owned -c max_connections=40 -c shared_buffers=64MB -c jit=off" -w start
pg_started=1
"$pg/createdb" -h 127.0.0.1 -p 15432 -U aiag_test ai_aggregator_test
"$root/usr/bin/redis-server" --bind 127.0.0.1 --port 16379 --save '' --appendonly no --dir "$owned" >"$owned/redis.log" 2>&1 &
redis_pid=$!
for attempt in {1..30}; do "$root/usr/bin/redis-cli" -h 127.0.0.1 -p 16379 ping 2>/dev/null | grep -q PONG && break; sleep 0.1; done
"$root/usr/bin/redis-cli" -h 127.0.0.1 -p 16379 ping | grep -q PONG
export DATABASE_URL='postgresql://aiag_test@127.0.0.1:15432/ai_aggregator_test'
export TEST_DATABASE_URL="$DATABASE_URL" AIAG_TEST_DATABASE=1
export REDIS_URL='redis://127.0.0.1:16379/0'
export NODE_ENV=test
cd "$repo"
echo 'Owned test services ready: PG15432, Redis16379; no production configuration loaded.'
"$@"
