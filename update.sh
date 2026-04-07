#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.openclaw/extensions/startup-suite-channel"

if [ ! -d "$EXT_DIR" ]; then
  echo "Error: Plugin not installed at $EXT_DIR"
  echo "Run install.sh first."
  exit 1
fi

echo "Updating Startup Suite Channel plugin..."

# ── 1. Copy plugin files (preserves existing config.json) ─────────
mkdir -p "$EXT_DIR/src"

cp "$SCRIPT_DIR/package.json" \
   "$SCRIPT_DIR/openclaw.plugin.json" \
   "$SCRIPT_DIR/index.ts" \
   "$SCRIPT_DIR/config.example.json" \
   "$EXT_DIR/"

cp "$SCRIPT_DIR/src/"*.ts "$EXT_DIR/src/"

echo "  ✓ Copied plugin files to $EXT_DIR"

# ── 2. Reinstall dependencies if package.json changed ─────────────
(cd "$EXT_DIR" && npm install --loglevel=warn)
echo "  ✓ Installed npm dependencies"

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "✅ Update complete! Restart the gateway to pick up changes:"
echo "  openclaw gateway restart"
