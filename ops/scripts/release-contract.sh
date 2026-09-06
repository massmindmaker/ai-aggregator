#!/usr/bin/env bash

# Shared release contract for the manual deploy script and GitHub Actions.
# This file is sourced; callers keep their own `set -euo pipefail` policy.

AIAG_DEPLOY_APPS=(web gateway worker)
AIAG_BUILD_PACKAGES=(shared database email telegram-alerts tinkoff yookassa)

aiag_validate_apps() {
  local app known
  for app in "$@"; do
    known=0
    case "$app" in
      web|gateway|worker) known=1 ;;
    esac
    [[ "$known" == 1 ]] || {
      echo "Unknown app: $app (allowed: ${AIAG_DEPLOY_APPS[*]})" >&2
      return 1
    }
  done
}

aiag_build_shared_packages() {
  local repo_root="$1"
  local bun_bin="${2:-bun}"
  local pkg

  for pkg in "${AIAG_BUILD_PACKAGES[@]}"; do
    "$bun_bin" run --cwd "$repo_root/packages/$pkg" build || return $?
  done
}

aiag_required_artifacts() {
  local app="$1"

  cat <<'ARTIFACTS'
packages/shared/dist/index.js
packages/database/dist/index.js
packages/email/dist/index.js
packages/telegram-alerts/dist/index.js
packages/tinkoff/dist/index.js
packages/yookassa/dist/index.js
ops/ecosystem.config.cjs
ops/runtime-env.cjs
ops/scripts/pm2-root.sh
ops/scripts/verify-ecosystem-config.cjs
ARTIFACTS

  case "$app" in
    web) echo 'apps/web/.next/BUILD_ID' ;;
    gateway) echo 'packages/api-gateway/dist/server-node.js' ;;
    worker) echo 'apps/worker/dist/index.js' ;;
    *)
      echo "Unknown app: $app (allowed: ${AIAG_DEPLOY_APPS[*]})" >&2
      return 1
      ;;
  esac
}

aiag_verify_release_artifacts() {
  local repo_root="$1"
  local app="$2"
  local artifact
  local missing=0

  while IFS= read -r artifact; do
    if [[ ! -f "$repo_root/$artifact" ]]; then
      echo "Missing required release artifact for $app: $artifact" >&2
      missing=1
    fi
  done < <(aiag_required_artifacts "$app")

  [[ "$missing" == 0 ]]
}
