#!/usr/bin/env bash
# Builds and starts Bursar on a remote Docker host from a git revision.
# Usage: deploy/deploy.sh [git-ref]
# Reads BURSAR_DEPLOY_HOST (ssh alias) and BURSAR_DEPLOY_DIR (absolute path) from the
# environment or from .env.deploy at the repository root.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [[ -f .env.deploy ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env.deploy
  set +a
fi
: "${BURSAR_DEPLOY_HOST:?set BURSAR_DEPLOY_HOST}"
: "${BURSAR_DEPLOY_DIR:?set BURSAR_DEPLOY_DIR}"

ref="${1:-HEAD}"
release="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short "$ref")"
workdir="$(mktemp -d)"
archive="$workdir/release.tar.gz"
cleanup() { rm -f "$archive"; rmdir "$workdir"; }
trap cleanup EXIT

git archive --format=tar.gz -o "$archive" "$ref"
scp -q "$archive" "$BURSAR_DEPLOY_HOST:$BURSAR_DEPLOY_DIR/incoming-$release.tar.gz"
ssh "$BURSAR_DEPLOY_HOST" \
  "set -e; d='$BURSAR_DEPLOY_DIR'; r='$release'; \
   mkdir -p \"\$d/releases/\$r\"; \
   tar -xzf \"\$d/incoming-\$r.tar.gz\" -C \"\$d/releases/\$r\"; \
   rm \"\$d/incoming-\$r.tar.gz\"; \
   bash \"\$d/releases/\$r/deploy/remote-update.sh\" \"\$d\" \"\$r\""
