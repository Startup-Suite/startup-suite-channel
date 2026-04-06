#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$HOME/.openclaw/extensions/startup-suite-channel"

ACCOUNT_ID="${1:-${SUITE_ACCOUNT_ID:-}}"

# Copy test script to extension dir and run from there so ESM resolves deps
if [ -d "$EXT_DIR/node_modules" ]; then
  mkdir -p "$EXT_DIR/scripts"
  cp "$SCRIPT_DIR/test-connection.js" "$EXT_DIR/scripts/test-connection.js"
  node "$EXT_DIR/scripts/test-connection.js" "$ACCOUNT_ID"
elif [ -d "$REPO_DIR/node_modules" ]; then
  node "$SCRIPT_DIR/test-connection.js" "$ACCOUNT_ID"
else
  echo "Dependencies not installed. Run: npm install (in repo root or extension dir)"
  exit 1
fi
