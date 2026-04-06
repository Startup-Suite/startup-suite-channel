#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.openclaw/extensions/startup-suite-channel"
OC_CONFIG="$HOME/.openclaw/openclaw.json"

# ── Parse arguments ────────────────────────────────────────────────
SUITE_URL=""
RUNTIME_ID=""
TOKEN=""
ACCOUNT_ID=""   # optional named account (for multi-agent setups)

usage() {
  echo "Usage: install.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --url URL            Suite WebSocket URL (default: wss://suite.milvenan.technology/runtime/ws)"
  echo "  --runtime-id ID      Runtime ID from Suite federate flow"
  echo "  --token TOKEN        Authentication token from Suite federate flow"
  echo "  --account-id NAME    Named account for multi-agent setups (e.g. 'beacon', 'sage')"
  echo "                       Omit for single-agent installs (uses config.json default)"
  echo "  -h, --help           Show this help"
  echo ""
  echo "Single-agent (default):"
  echo "  ./install.sh"
  echo "  ./install.sh --runtime-id my-runtime --token abc123"
  echo ""
  echo "Multi-agent (adds a named account to openclaw.json):"
  echo "  ./install.sh --account-id beacon --runtime-id beacon-id --token beacon-token"
  echo "  ./install.sh --account-id sage   --runtime-id sage-id   --token sage-token"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) SUITE_URL="$2"; shift 2 ;;
    --runtime-id) RUNTIME_ID="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
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
  echo "For multiple agents on one gateway, run this script once per agent"
  echo "with --account-id <name> to add named accounts to openclaw.json."
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

  if [ -z "$ACCOUNT_ID" ]; then
    echo ""
    echo "Account ID is optional. Leave blank for a single-agent setup."
    echo "Use a name (e.g. 'beacon') if you're adding a second agent to an existing install."
    read -rp "Account ID [leave blank for default]: " ACCOUNT_ID
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
   "$SCRIPT_DIR/setup-entry.ts" \
   "$SCRIPT_DIR/config.example.json" \
   "$EXT_DIR/"

cp "$SCRIPT_DIR/src/"*.ts "$EXT_DIR/src/"

echo "  ✓ Copied plugin files to $EXT_DIR"

# ── 2. Install npm dependencies ───────────────────────────────────
(cd "$EXT_DIR" && npm install --loglevel=warn)
echo "  ✓ Installed npm dependencies"

# ── 3. Write config ────────────────────────────────────────────────
# Single-agent: write config.json (backward compat default account)
# Multi-agent: write named account into openclaw.json accounts map

configure_with_python() {
  python3 - "$OC_CONFIG" "$SUITE_URL" "$RUNTIME_ID" "$TOKEN" "$ACCOUNT_ID" <<'PYEOF'
import json, sys

path, url, runtime_id, token, account_id = sys.argv[1:6]

try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}

# Ensure channels.startup-suite
cfg.setdefault("channels", {})
cfg["channels"].setdefault("startup-suite", {
    "enabled": True,
    "dmPolicy": "allowlist",
    "allowFrom": ["*"]
})

# Multi-agent: add named account to accounts map
if account_id:
    cfg["channels"]["startup-suite"].setdefault("accounts", {})
    cfg["channels"]["startup-suite"]["accounts"][account_id] = {
        "url": url,
        "runtimeId": runtime_id,
        "token": token,
        "autoJoinSpaces": [],
        "reconnectIntervalMs": 5000,
        "maxReconnectIntervalMs": 60000
    }

# Ensure plugins.allow includes startup-suite-channel-plugin
cfg.setdefault("plugins", {})
allow = cfg["plugins"].setdefault("allow", [])
if "startup-suite-channel-plugin" not in allow:
    allow.append("startup-suite-channel-plugin")
# Remove old name if present
if "startup-suite-channel" in allow:
    allow.remove("startup-suite-channel")

# Ensure plugins.entries includes startup-suite-channel-plugin
entries = cfg["plugins"].setdefault("entries", {})
if isinstance(entries, list):
    # Migrate from old list format to dict
    entries = {}
    cfg["plugins"]["entries"] = entries
if "startup-suite-channel-plugin" not in entries:
    entries["startup-suite-channel-plugin"] = {"enabled": True}
# Remove old name if present
entries.pop("startup-suite-channel", None)

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PYEOF
}

if [ -n "$ACCOUNT_ID" ]; then
  # Multi-agent: write account into openclaw.json
  configure_with_python
  echo "  ✓ Added account '$ACCOUNT_ID' to openclaw.json (channels.startup-suite.accounts.$ACCOUNT_ID)"
else
  # Single-agent: write config.json + register channel/plugin in openclaw.json
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
  configure_with_python
  echo "  ✓ Configured openclaw.json"
fi

# ── 4. Test connection (optional) ─────────────────────────────────
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

if [ -n "$ACCOUNT_ID" ]; then
  echo "Account '$ACCOUNT_ID' added. Run again with a different --account-id to add more agents."
  echo ""
fi

echo "Restart OpenClaw to activate:"
echo "  openclaw gateway restart"
