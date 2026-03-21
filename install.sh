#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.openclaw/extensions/startup-suite-channel"
OC_CONFIG="$HOME/.openclaw/openclaw.json"

# ── Parse arguments ────────────────────────────────────────────────
SUITE_URL=""
RUNTIME_ID=""
TOKEN=""

usage() {
  echo "Usage: install.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --url URL          Suite WebSocket URL (default: wss://suite.milvenan.technology/runtime/ws)"
  echo "  --runtime-id ID    Runtime ID from Suite federate flow"
  echo "  --token TOKEN      Authentication token from Suite federate flow"
  echo "  -h, --help         Show this help"
  echo ""
  echo "Interactive mode (no args):"
  echo "  ./install.sh"
  echo ""
  echo "Non-interactive mode:"
  echo "  ./install.sh --runtime-id my-runtime --token abc123"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) SUITE_URL="$2"; shift 2 ;;
    --runtime-id) RUNTIME_ID="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# ── Interactive prompts if values not provided ─────────────────────
if [ -z "$RUNTIME_ID" ] || [ -z "$TOKEN" ]; then
  echo "Startup Suite Channel — Plugin Installer"
  echo "========================================="
  echo ""
  echo "You'll need a runtime ID and token from Suite."
  echo "Get these from: Agent Resources → Add Agent → Federate"
  echo ""

  if [ -z "$SUITE_URL" ]; then
    read -rp "Suite URL [wss://suite.milvenan.technology/runtime/ws]: " SUITE_URL
  fi

  if [ -z "$RUNTIME_ID" ]; then
    read -rp "Runtime ID: " RUNTIME_ID
    if [ -z "$RUNTIME_ID" ]; then
      echo "Error: Runtime ID is required."
      exit 1
    fi
  fi

  if [ -z "$TOKEN" ]; then
    read -rp "Token: " TOKEN
    if [ -z "$TOKEN" ]; then
      echo "Error: Token is required."
      exit 1
    fi
  fi

  echo ""
fi

SUITE_URL="${SUITE_URL:-wss://suite.milvenan.technology/runtime/ws}"

echo "Installing Startup Suite Channel plugin..."
echo ""

# ── 1. Copy files ──────────────────────────────────────────────────
mkdir -p "$EXT_DIR/src"

cp "$SCRIPT_DIR/package.json" \
   "$SCRIPT_DIR/openclaw.plugin.json" \
   "$SCRIPT_DIR/index.ts" \
   "$SCRIPT_DIR/config.example.json" \
   "$EXT_DIR/"

cp "$SCRIPT_DIR/src/"*.ts "$EXT_DIR/src/"

echo "  ✓ Copied plugin files to $EXT_DIR"

# ── 2. Install npm dependencies ───────────────────────────────────
(cd "$EXT_DIR" && npm install --loglevel=warn)
echo "  ✓ Installed npm dependencies"

# ── 3. Write config.json with provided values ─────────────────────
cat > "$EXT_DIR/config.json" <<CONFIGEOF
{
  "url": "$SUITE_URL",
  "runtimeId": "$RUNTIME_ID",
  "token": "$TOKEN",
  "autoJoinSpaces": [],
  "reconnectIntervalMs": 5000,
  "maxReconnectIntervalMs": 60000
}
CONFIGEOF
echo "  ✓ Wrote config.json with runtime credentials"

# ── 4. Register channel + plugin in openclaw.json ─────────────────
configure_with_python() {
  python3 - "$OC_CONFIG" <<'PYEOF'
import json, sys

path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}

# Ensure channels.startup-suite
cfg.setdefault("channels", {})
cfg["channels"]["startup-suite"] = {
    "enabled": True,
    "dmPolicy": "allowlist",
    "allowFrom": ["*"]
}

# Ensure plugins.allow includes startup-suite-channel
cfg.setdefault("plugins", {})
allow = cfg["plugins"].setdefault("allow", [])
if "startup-suite-channel" not in allow:
    allow.append("startup-suite-channel")

# Ensure plugins.entries includes startup-suite-channel
entries = cfg["plugins"].setdefault("entries", [])
if "startup-suite-channel" not in entries:
    entries.append("startup-suite-channel")

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PYEOF
}

configure_with_python
echo "  ✓ Configured openclaw.json"

# ── 5. Test connection (optional) ─────────────────────────────────
echo ""
read -rp "Test connection now? [Y/n]: " TEST_NOW
TEST_NOW="${TEST_NOW:-y}"

if [[ "$TEST_NOW" =~ ^[Yy] ]]; then
  if [ -f "$SCRIPT_DIR/scripts/test-connection.sh" ]; then
    bash "$SCRIPT_DIR/scripts/test-connection.sh"
  elif [ -f "$SCRIPT_DIR/scripts/test-connection.js" ]; then
    node "$SCRIPT_DIR/scripts/test-connection.js"
  else
    echo "  No test script found — skipping"
  fi
fi

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo "✅ Installation complete!"
echo ""
echo "Restart OpenClaw to activate:"
echo "  openclaw gateway restart"
