#!/usr/bin/env bash
# Off-cluster restore stand: a disposable, fully independent PostgreSQL cluster
# for rehearsing restores. Source and destination live in DIFFERENT clusters,
# so source-level global roles never leak into the destination automatically —
# roles must be recreated by hand, which is exactly what breaks during a real
# off-host restore.
#
# Never touches the primary cluster on 15432: own PGDATA, own port, own socket dir.
#
# Usage:  restore-stand.sh {start|stop|reset|psql ...}
# Env:    PGDATA  data directory (default: /tmp/aiag-restore-stand)
#         PGPORT  TCP port       (default: 15433, the destination stand port;
#                                15432 is reserved for the source cluster)
#
# Test-stand only: 127.0.0.1 bind, trust auth on localhost, fsync=off. See
# docs/operations/off-cluster-restore-stand.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
T="$REPO_ROOT/.superpowers/tools/native18/root"
BIN="$T/usr/lib/postgresql/18/bin"
LIB="$T/usr/lib/x86_64-linux-gnu"
PGDATA="${PGDATA:-/tmp/aiag-restore-stand}"
PGPORT="${PGPORT:-15433}"

export LD_LIBRARY_PATH="$LIB"
export LANG=C.UTF-8

case "${1:-}" in
  start)
    if [ -f "$PGDATA/postmaster.pid" ]; then
      echo "already running: $PGDATA (use 'reset' first if it is stale)" >&2; exit 0
    fi
    # Refuse to wipe a directory that does not look like a stand this script created.
    # PGDATA comes from the environment, so an unguarded rm -rf could otherwise take
    # an arbitrary non-empty directory with no prompt at all.
    if [ -d "$PGDATA" ] && [ -n "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
      if [ ! -f "$PGDATA/PG_VERSION" ] && [ ! -f "$PGDATA/server.log" ]; then
        echo "refusing to wipe: $PGDATA exists, is not empty and has no PG_VERSION/server.log" >&2
        echo "point PGDATA at a fresh path, or remove it yourself if that is really a stand" >&2
        exit 65
      fi
    fi
    rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chmod 700 "$PGDATA"
    "$BIN/initdb" -D "$PGDATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null
    # unix_socket_directories inside our own PGDATA: the system dir may be absent or
    # unwritable, and this stand must not depend on shared cluster state.
    # Quoted: PGDATA with spaces would otherwise split inside pg_ctl's -o string.
    "$BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" \
      -o "-p $PGPORT -h 127.0.0.1 -c listen_addresses=127.0.0.1 -c fsync=off -c unix_socket_directories='$PGDATA'" \
      -w start >/dev/null
    echo "started on 127.0.0.1:$PGPORT ($PGDATA)"
    ;;
  stop)
    "$BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null
    echo "stopped"
    ;;
  reset)
    "$BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
    rm -rf "$PGDATA"
    echo "removed $PGDATA"
    ;;
  psql)
    shift
    # Export PGPORT so both psql's own defaults and any consumer (pg_dump,
    # CREATE DATABASE wrappers) target the caller-selected cluster, not the
    # ambient default. The explicit -p below is belt-and-braces for callers
    # that clear the environment between argument parsing and connect.
    export PGPORT
    exec "$BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres "$@"
    ;;
  *)
    echo "usage: $0 {start|stop|reset|psql ...}" >&2; exit 2
    ;;
esac
