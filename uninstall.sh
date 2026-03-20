#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="$HOME/.openclaw/extensions/startup-suite-channel"
OC_CONFIG="$HOME/.openclaw/openclaw.json"

echo "Uninstalling Startup Suite Channel plugin..."
echo ""

# ── 1. Remove extension directory ─────────────────────────────────
if [ -d "$EXT_DIR" ]; then
  rm -rf "$EXT_DIR"
  echo "  Removed $EXT_DIR"
else
  echo "  Extension directory not found (already removed?)"
fi

# ── 2. Remove config from openclaw.json ───────────────────────────
remove_with_cli() {
  openclaw config unset channels.startup-suite 2>/dev/null
}

remove_with_python() {
  python3 - "$OC_CONFIG" <<'PYEOF'
import json, sys

path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    print("  openclaw.json not found or invalid — skipping")
    sys.exit(0)

# Remove channels.startup-suite
cfg.get("channels", {}).pop("startup-suite", None)

# Remove from plugins.allow
plugins = cfg.get("plugins", {})
if "startup-suite-channel" in plugins.get("allow", []):
    plugins["allow"].remove("startup-suite-channel")

# Remove from plugins.entries
if "startup-suite-channel" in plugins.get("entries", []):
    plugins["entries"].remove("startup-suite-channel")

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PYEOF
}

if command -v openclaw &>/dev/null && remove_with_cli; then
  openclaw config unset plugins.allow.startup-suite-channel 2>/dev/null || true
  openclaw config unset plugins.entries.startup-suite-channel 2>/dev/null || true
  echo "  Removed plugin config via CLI"
else
  remove_with_python
  echo "  Removed plugin config via python3"
fi

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo "Uninstall complete!"
echo ""
echo "Restart the gateway to apply changes:"
echo "  openclaw gateway restart"
