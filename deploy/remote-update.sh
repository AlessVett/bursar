#!/usr/bin/env bash
# Runs on the Docker host: points "current" at a release and (re)starts the stack.
# Usage: remote-update.sh <deploy dir> <release name>
set -euo pipefail

dir="$1"
release="$2"
release_dir="$dir/releases/$release"

[[ -f "$dir/.env" ]] || { echo "Missing $dir/.env" >&2; exit 1; }

# Same lookup as compose: BURSAR_SECRETS_DIR from .env, default ./secrets,
# relative paths resolved against the compose project directory.
secrets_dir="$(sed -n 's/^BURSAR_SECRETS_DIR=//p' "$dir/.env" | tail -n 1)"
secrets_dir="${secrets_dir%[\"\']}"
secrets_dir="${secrets_dir#[\"\']}"
secrets_dir="${secrets_dir:-./secrets}"
[[ "$secrets_dir" == /* ]] || secrets_dir="$release_dir/deploy/$secrets_dir"

[[ -f "$secrets_dir/master_key" ]] || { echo "Missing $secrets_dir/master_key" >&2; exit 1; }

compose=(docker compose --env-file "$dir/.env" -f "$release_dir/deploy/compose.yaml")
if [[ -f "$secrets_dir/claude_credential" ]]; then
  compose+=(-f "$release_dir/deploy/compose.claude.yaml")
fi

"${compose[@]}" --profile tunnel up -d --build --remove-orphans --wait --wait-timeout 180
ln -sfn "$release_dir" "$dir/current"
"${compose[@]}" --profile tunnel ps
