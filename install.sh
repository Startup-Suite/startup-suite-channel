#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.openclaw/extensions/startup-suite-channel"
OC_CONFIG="$HOME/.openclaw/openclaw.json"

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

echo "  Copied plugin files to $EXT_DIR"

# ── 2. Install npm dependencies ───────────────────────────────────
(cd "$EXT_DIR" && npm install --loglevel=warn)
echo "  Installed npm dependencies"

# ── 3. Create config.json from example if missing ─────────────────
if [ ! -f "$EXT_DIR/config.json" ]; then
  cp "$SCRIPT_DIR/config.example.json" "$EXT_DIR/config.json"
  echo "  Created config.json from example"
else
  echo "  config.json already exists — keeping existing"
fi

# ── 4. Register channel + plugin in openclaw.json ─────────────────
configure_with_cli() {
  openclaw config set channels.startup-suite.enabled true 2>/dev/null &&
  openclaw config set channels.startup-suite.dmPolicy allowlist 2>/dev/null &&
  openclaw config set 'channels.startup-suite.allowFrom[0]' '*' 2>/dev/null
}

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

if command -v openclaw &>/dev/null && configure_with_cli; then
  # Also add plugin entries via CLI if supported, fall back to python
  openclaw config set 'plugins.allow[]' startup-suite-channel 2>/dev/null || true
  openclaw config set 'plugins.entries[]' startup-suite-channel 2>/dev/null || true
  echo "  Configured openclaw.json via CLI"
else
  configure_with_python
  echo "  Configured openclaw.json via python3"
fi

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Register a runtime in Suite:"
echo "     Agent Resources -> Add Agent -> Federate"
echo ""
echo "  2. Copy the runtime_id and token, then edit:"
echo "     $EXT_DIR/config.json"
echo ""
echo "  3. Test the connection:"
echo "     bash $SCRIPT_DIR/scripts/test-connection.sh"
echo ""
echo "  4. Restart the gateway:"
echo "     openclaw gateway restart"
