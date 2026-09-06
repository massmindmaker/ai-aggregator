#!/usr/bin/env bash
# Plan 08 Task 8 — Локальный deploy AI-Aggregator на bare-metal VPS.
# Альтернатива GitHub Actions (.github/workflows/deploy-production.yml) для ручных deploy.
#
# Usage:
#   ops/scripts/deploy.sh                      # deploys всё (web, gateway, worker)
#   ops/scripts/deploy.sh web gateway          # только указанные apps
#   APPS="web" SSH_HOST=aiag-vps ops/scripts/deploy.sh
#   ops/scripts/deploy.sh --print-plan         # показать default без SSH/deploy
#
# Env vars:
#   SSH_HOST       — SSH alias (default: aiag-vps)
#   APPS           — пробельный список apps (default: web gateway worker)
#   DRY_RUN        — 1 = только показать команды
#   SKIP_BUILD     — 1 = пропустить локальный build (использовать существующие dist)
#   KEEP_RELEASES  — сколько последних releases оставить (default: 5)
set -euo pipefail

SSH_HOST="${SSH_HOST:-aiag-vps}"
APPS_INPUT="${APPS:-}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=release-contract.sh
source "$REPO_ROOT/ops/scripts/release-contract.sh"

PRINT_PLAN=0
if [[ "${1:-}" == "--print-plan" ]]; then
  PRINT_PLAN=1
  shift
fi

if [[ "$#" -gt 0 ]]; then
  APPS=("$@")
elif [[ -n "$APPS_INPUT" ]]; then
  read -r -a APPS <<< "$APPS_INPUT"
else
  APPS=("${AIAG_DEPLOY_APPS[@]}")
fi
aiag_validate_apps "${APPS[@]}" || exit 1

if [[ "$PRINT_PLAN" == 1 ]]; then
  echo "${APPS[*]}"
  exit 0
fi

RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

log()  { echo "[$(date +%H:%M:%S)] $*" >&2; }
fail() { log "ERROR: $*"; exit 1; }
run()  { if [[ "$DRY_RUN" = "1" ]]; then echo "DRY: $*"; else eval "$@"; fi; }

# 1. Pre-flight checks
log "Release tag: $RELEASE"
log "Apps: ${APPS[*]}"
log "Target: $SSH_HOST"

[[ -d "$REPO_ROOT/apps" ]] || fail "Wrong REPO_ROOT: $REPO_ROOT"
ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_HOST" 'echo ok' >/dev/null 2>&1 \
  || fail "Cannot reach $SSH_HOST via SSH (key auth required)"

# 2. Build apps
if [[ "$SKIP_BUILD" != "1" ]]; then
  log "Building shared packages"
  for pkg in "${AIAG_BUILD_PACKAGES[@]}"; do
    run "bun run --cwd '$REPO_ROOT/packages/$pkg' build"
  done

  for app in "${APPS[@]}"; do
    case "$app" in
      web)          run "bun run --cwd '$REPO_ROOT/apps/web' build" ;;
      gateway)      run "bun run --cwd '$REPO_ROOT/packages/api-gateway' build" ;;
      worker)       run "bun run --cwd '$REPO_ROOT/apps/worker' build" ;;
      *)            fail "Unknown app: $app" ;;
    esac
  done
else
  log "Skipping build (SKIP_BUILD=1)"
fi

node "$REPO_ROOT/ops/scripts/verify-ecosystem-config.cjs" \
  "$REPO_ROOT/ops/ecosystem.config.cjs" "$REPO_ROOT/.env.example"
for app in "${APPS[@]}"; do
  aiag_verify_release_artifacts "$REPO_ROOT" "$app" \
    || fail "Release artifact preflight failed for $app"
done

# 3. Build release tarball
PKG_DIR="$REPO_ROOT/.deploy"
mkdir -p "$PKG_DIR"
TARBALL="$PKG_DIR/$RELEASE.tar.gz"

log "Packaging release → $TARBALL"
run "tar --exclude='node_modules' --exclude='.git' --exclude='.deploy' \
        --exclude='.next/cache' --exclude='*.log' \
        -czf '$TARBALL' -C '$REPO_ROOT' ."

# 4. Upload
log "Uploading release"
run "ssh '$SSH_HOST' 'mkdir -p /srv/aiag/deploy/tmp/$RELEASE'"
run "scp -q '$TARBALL' '$SSH_HOST:/srv/aiag/deploy/tmp/$RELEASE/release.tar.gz'"

# 5. Atomic swap + pm2 reload + healthcheck (remote)
log "Atomic swap + pm2 reload"
APPS_STR="${APPS[*]}"
ssh "$SSH_HOST" "RELEASE='$RELEASE' APPS='$APPS_STR' KEEP='$KEEP_RELEASES' bash -s" <<'REMOTE'
set -euo pipefail
log() { echo "[remote $(date +%H:%M:%S)] $*"; }
ECOSYSTEM="/srv/aiag/shared/ecosystem.config.cjs"

for APP in $APPS; do
  TARGET="/srv/aiag/$APP/releases/$RELEASE"
  CURRENT="/srv/aiag/$APP/current"
  PREV_LINK="$(readlink "$CURRENT" 2>/dev/null || echo '')"

  log "Deploy $APP → $TARGET"
  mkdir -p "$TARGET"
  tar -xzf "/srv/aiag/deploy/tmp/$RELEASE/release.tar.gz" -C "$TARGET"

  # Production install from the committed Bun lockfile.
  cd "$TARGET"
  bun install --production --frozen-lockfile

  # The release contains the reviewed process contract. Validate it before
  # installing the exact file used by the pm2 self-heal fallback.
  node ops/scripts/verify-ecosystem-config.cjs \
    ops/ecosystem.config.cjs /srv/aiag/shared/.env
  install -d "$(dirname "$ECOSYSTEM")"
  install -m 0644 ops/runtime-env.cjs "$(dirname "$ECOSYSTEM")/runtime-env.cjs"
  install -m 0644 ops/ecosystem.config.cjs "$ECOSYSTEM"

  # Every lifecycle and inspection command targets the root-owned daemon.
  # shellcheck source=pm2-root.sh
  source ops/scripts/pm2-root.sh

  # Atomic symlink swap
  ln -sfn "$TARGET" "$CURRENT"

  # Reload an existing process or recreate it from the committed contract.
  aiag_pm2_reload_or_create "$APP" "$ECOSYSTEM"
  aiag_pm2 save

  # Healthcheck (HTTP /health on PM2-reported port)
  PORT=$(aiag_pm2 jlist | jq -r ".[] | select(.name==\"$APP\") | .pm2_env.env.PORT // empty")
  if [[ -n "$PORT" ]]; then
    sleep 4
    if ! curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null; then
      log "HEALTH FAILED for $APP — rolling back"
      if [[ -n "$PREV_LINK" ]]; then
        ln -sfn "$PREV_LINK" "$CURRENT"
        aiag_pm2_reload_or_create "$APP" "$ECOSYSTEM"
        aiag_pm2 save
        log "Rollback to $PREV_LINK done"
      fi
      exit 1
    fi
    log "Health OK for $APP on :$PORT"
  fi

  # Cleanup old releases
  cd "/srv/aiag/$APP/releases"
  ls -1t | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
done

# Cleanup tmp tarball
rm -rf "/srv/aiag/deploy/tmp/$RELEASE"
log "Deploy complete: $RELEASE"
REMOTE

log "SUCCESS — $RELEASE deployed to $SSH_HOST"

# 6. Optional: notify Telegram
if [[ -n "${TELEGRAM_ALERT_BOT_TOKEN:-}" && -n "${TELEGRAM_ALERT_CHAT_ID:-}" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_ALERT_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_ALERT_CHAT_ID}" \
    -d "text=Deploy OK: $RELEASE apps=${APPS[*]}" >/dev/null
fi
