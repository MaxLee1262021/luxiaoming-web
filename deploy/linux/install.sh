#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 18 or later and npm are required." >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18 or later is required; found $(node --version)." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "Missing .env. Restore the deployment configuration before installing." >&2
  exit 1
fi

chmod 600 .env
npm ci --omit=dev --include=optional
npm run check

echo "Installation complete. Before first production startup, run the MySQL dry-run migration and verify its output."
