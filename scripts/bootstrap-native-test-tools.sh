#!/usr/bin/env bash
# Unpack distribution-signed packages into ignored project storage; no sudo/services.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
command -v apt-get >/dev/null
command -v dpkg-deb >/dev/null
root="$repo/.superpowers/tools/native18"
mkdir -p "$root/debs" "$root/root"
exec 9>/tmp/ai-ecosystem-build.lock
flock -w 120 9 || exit 75
cd "$root/debs"
apt-get download postgresql-18 postgresql-client-18 redis-server redis-tools libpq5 liblzf1
for package in ./*.deb; do dpkg-deb -x "$package" "$root/root"; done
export LD_LIBRARY_PATH="$root/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$root/root/usr/lib/postgresql/18/bin/postgres" --version
"$root/root/usr/bin/redis-server" --version
sha256sum ./*.deb > "$root/packages.sha256"
echo "Native tools verified at $root/root. No system service or database changed."
