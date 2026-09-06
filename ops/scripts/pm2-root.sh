#!/usr/bin/env bash

# Production PM2 is root-owned. Never fall back to the SSH user's daemon:
# a successful user-daemon command can create duplicate consumers or ports.

aiag_pm2() {
  sudo -n pm2 "$@"
}

aiag_pm2_reload_or_create() {
  local app="$1"
  local ecosystem="$2"

  # PM2 reads the committed ecosystem on both branches: reload existing or
  # create missing. This also refreshes its parsed shared environment.
  aiag_pm2 startOrReload "$ecosystem" --only "$app" --update-env
}

aiag_pm2_status() {
  local app="$1"
  aiag_pm2 jlist | jq -r ".[] | select(.name==\"$app\") | .pm2_env.status" | head -n1
}
