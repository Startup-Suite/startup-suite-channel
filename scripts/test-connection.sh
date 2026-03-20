#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$HOME/.openclaw/extensions/startup-suite-channel"

# Use the installed extension's node_modules if available, otherwise repo root
if [ -d "$EXT_DIR/node_modules" ]; then
  NODE_PATH="$EXT_DIR/node_modules"
elif [ -d "$REPO_DIR/node_modules" ]; then
  NODE_PATH="$REPO_DIR/node_modules"
else
  echo "Dependencies not installed. Run: npm install (in repo root or extension dir)"
  exit 1
fi

NODE_PATH="$NODE_PATH" node "$SCRIPT_DIR/test-connection.js"
