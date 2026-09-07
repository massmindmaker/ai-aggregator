#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

NEXT_CONFIG="$REPO_ROOT/apps/web/next.config.mjs"
HEALTH_ROUTE="$REPO_ROOT/apps/web/src/app/health/route.ts"
FAQ_COMPONENT="$REPO_ROOT/apps/web/src/components/home/HomeFaq.tsx"
SAFE_FETCH="$REPO_ROOT/packages/shared/src/safe-fetch.ts"

grep -q "serverComponentsExternalPackages: \['@neondatabase/serverless'\]" "$NEXT_CONFIG" \
  || fail 'Next 14 serverComponentsExternalPackages setting is missing'
if grep -q '^[[:space:]]*serverExternalPackages:' "$NEXT_CONFIG"; then
  fail 'unsupported Next 15 serverExternalPackages setting remains'
fi

grep -q "^export const runtime = 'nodejs';$" "$HEALTH_ROUTE" \
  || fail '/health runtime is not a local string literal'
grep -q "^export const dynamic = 'force-dynamic';$" "$HEALTH_ROUTE" \
  || fail '/health dynamic mode is not a local string literal'

if grep -Fq 'duration-[400ms]' "$FAQ_COMPONENT"; then
  fail 'ambiguous Tailwind duration utility remains'
fi

grep -q "from 'undici'" "$SAFE_FETCH" \
  || fail 'shared safe-fetch does not use a statically analyzable undici dependency'
if grep -Eq "const mod = 'undici'|import\([^)]*mod" "$SAFE_FETCH"; then
  fail 'shared safe-fetch still contains an expression-based dependency import'
fi

echo 'release warning contracts passed'
