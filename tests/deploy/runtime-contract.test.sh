#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ENV_FILE="$TMP_DIR/shared.env"
MARKER="$TMP_DIR/must-not-exist"
SECRET_VALUE='runtime-secret-do-not-log'
cat > "$ENV_FILE" <<EOF
DATABASE_URL=postgresql://fresh-process/db
REDIS_URL="redis://fresh-process:6379"
NEXTAUTH_SECRET='$SECRET_VALUE'
DANGEROUS=\$(touch $MARKER)
COMMENTED="value # retained" # ignored comment
MULTILINE="first line
second line"
EOF

ENV_OUTPUT="$TMP_DIR/env-output.log"
if ! env -i PATH="$PATH" AIAG_SHARED_ENV_PATH="$ENV_FILE" REPO_ROOT="$REPO_ROOT" MARKER="$MARKER" \
  node <<'NODE' >"$ENV_OUTPUT" 2>&1
const { spawnSync } = require('node:child_process');
const { assertSupportedNode } = require(`${process.env.REPO_ROOT}/ops/runtime-env.cjs`);

assertSupportedNode('20.12.0');
assertSupportedNode('21.7.0', () => ({}));
try {
  assertSupportedNode('20.11.1');
  throw new Error('unsupported Node version passed the deployment preflight');
} catch (error) {
  if (!error.message.includes('requires Node.js >= 20.12.0')) throw error;
}
try {
  assertSupportedNode('21.6.0', null);
  throw new Error('runtime without util.parseEnv passed the deployment preflight');
} catch (error) {
  if (!error.message.includes('node:util.parseEnv')) throw error;
}

const config = require(`${process.env.REPO_ROOT}/ops/ecosystem.config.cjs`);
if (process.env.DATABASE_URL !== undefined || process.env.NEXTAUTH_SECRET !== undefined) {
  throw new Error('ecosystem validation mutated the validator process environment');
}

for (const app of config.apps) {
  const child = spawnSync(process.execPath, ['-e', `
    const expected = {
      DATABASE_URL: 'postgresql://fresh-process/db',
      REDIS_URL: 'redis://fresh-process:6379',
      NEXTAUTH_SECRET: 'runtime-secret-do-not-log',
      COMMENTED: 'value # retained',
      MULTILINE: 'first line\\nsecond line',
    };
    for (const [key, value] of Object.entries(expected)) {
      if (process.env[key] !== value) throw new Error('fresh child is missing ' + key);
    }
  `], { env: app.env, encoding: 'utf8' });
  if (child.status !== 0) {
    throw new Error(`${app.name} fresh child failed: ${child.stderr}`);
  }
}

if (config.apps[0].env.DANGEROUS !== `$(touch ${process.env.MARKER})`) {
  throw new Error('shell-like dotenv value was changed');
}
console.log('fresh process env passed');
NODE
then
  cat "$ENV_OUTPUT" >&2
  fail 'fresh process environment contract failed'
fi

[[ ! -e "$MARKER" ]] || fail 'dotenv content was executed by a shell'
grep -q '^fresh process env passed$' "$ENV_OUTPUT" || fail 'fresh process env was not populated'
if grep -q "$SECRET_VALUE" "$ENV_OUTPUT"; then
  fail 'secret value appeared in test output'
fi

VALIDATOR_OUTPUT="$TMP_DIR/validator-output.log"
node "$REPO_ROOT/ops/scripts/verify-ecosystem-config.cjs" \
  "$REPO_ROOT/ops/ecosystem.config.cjs" "$ENV_FILE" >"$VALIDATOR_OUTPUT" 2>&1
grep -q '^ecosystem contract ok: gateway, web, worker$' "$VALIDATOR_OUTPUT" \
  || fail 'runtime environment did not pass the ecosystem validator'
if grep -q "$SECRET_VALUE" "$VALIDATOR_OUTPUT"; then
  fail 'ecosystem validator logged a secret value'
fi

FAKE_BIN="$TMP_DIR/bin"
PM2_LOG="$TMP_DIR/pm2.log"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/sudo" <<'SUDO'
#!/usr/bin/env bash
[[ "$1" == '-n' && "$2" == 'pm2' ]] || exit 90
shift 2
AIAG_PM2_ROOT=1 pm2 "$@"
SUDO
cat > "$FAKE_BIN/pm2" <<'PM2'
#!/usr/bin/env bash
[[ "${AIAG_PM2_ROOT:-}" == 1 ]] || exit 91
echo "$*" >> "$PM2_LOG"
case "$1" in
  jlist) printf '[{"name":"worker","pm2_env":{"status":"online"}}]\n' ;;
esac
PM2
chmod +x "$FAKE_BIN/sudo" "$FAKE_BIN/pm2"
export PATH="$FAKE_BIN:$PATH" PM2_LOG

# shellcheck source=../../ops/scripts/pm2-root.sh
source "$REPO_ROOT/ops/scripts/pm2-root.sh"
aiag_pm2_reload_or_create worker /srv/aiag/shared/ecosystem.config.cjs
[[ "$(aiag_pm2_status worker)" == online ]] || fail 'root-owned status lookup failed'
aiag_pm2 save

for command in 'startOrReload /srv/aiag/shared/ecosystem.config.cjs' 'jlist' 'save'; do
  grep -q "^$command" "$PM2_LOG" || fail "missing root-owned PM2 command: $command"
done

echo 'runtime env and root PM2 contract passed'
