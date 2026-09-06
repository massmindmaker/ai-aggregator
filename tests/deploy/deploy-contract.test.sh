#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../ops/scripts/release-contract.sh
source "$REPO_ROOT/ops/scripts/release-contract.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

PLAN="$(bash "$REPO_ROOT/ops/scripts/deploy.sh" --print-plan)"
[[ "$PLAN" == 'web gateway worker' ]] || fail "default deploy plan is: $PLAN"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BUN="$TMP_DIR/bun"
BUILD_LOG="$TMP_DIR/build.log"
cat > "$FAKE_BUN" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$BUILD_LOG"
[[ "$*" != *'/database build' ]]
FAKE
chmod +x "$FAKE_BUN"
export BUILD_LOG

if aiag_build_shared_packages "$REPO_ROOT" "$FAKE_BUN"; then
  fail 'shared build failure was swallowed'
fi

mapfile -t BUILDS < "$BUILD_LOG"
[[ "${#BUILDS[@]}" == 2 ]] || fail "build continued after failure: ${BUILDS[*]}"
[[ "${BUILDS[0]}" == *'/shared build' ]] || fail 'shared was not the first required build'
[[ "${BUILDS[1]}" == *'/database build' ]] || fail 'database failure was not observed'

RELEASE_ROOT="$TMP_DIR/release"
while IFS= read -r artifact; do
  mkdir -p "$RELEASE_ROOT/$(dirname "$artifact")"
  : > "$RELEASE_ROOT/$artifact"
done < <(aiag_required_artifacts worker)

aiag_verify_release_artifacts "$RELEASE_ROOT" worker
rm "$RELEASE_ROOT/apps/worker/dist/index.js"
if aiag_verify_release_artifacts "$RELEASE_ROOT" worker 2>/dev/null; then
  fail 'missing worker entrypoint passed release preflight'
fi

node "$REPO_ROOT/ops/scripts/verify-ecosystem-config.cjs" \
  "$REPO_ROOT/ops/ecosystem.config.cjs" >/dev/null

grep -q 'aiag_build_shared_packages' "$REPO_ROOT/.github/workflows/deploy-production.yml" \
  || fail 'workflow does not use the fail-fast shared build contract'
grep -q 'aiag_verify_release_artifacts' "$REPO_ROOT/.github/workflows/deploy-production.yml" \
  || fail 'workflow does not verify runtime artifacts before packaging'

echo 'deploy contract tests passed'
