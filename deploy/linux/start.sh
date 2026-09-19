#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "Missing .env. Restore the deployment configuration before starting." >&2
  exit 1
fi

exec node server/index.cjs
