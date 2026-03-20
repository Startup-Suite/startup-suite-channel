#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="$HOME/.openclaw/extensions/startup-suite-channel"

echo "Installing Startup Suite Channel plugin..."

# Create extension directory
mkdir -p "$EXT_DIR/src"

# Copy files
cp package.json openclaw.plugin.json index.ts "$EXT_DIR/"
cp config.example.json "$EXT_DIR/"
cp src/*.ts "$EXT_DIR/src/"

# Create config.json from example if it doesn't exist
if [ ! -f "$EXT_DIR/config.json" ]; then
  cp config.example.json "$EXT_DIR/config.json"
  echo "Created config.json from example — edit it with your runtime credentials."
fi

# Install npm dependencies
cd "$EXT_DIR"
npm install

# Enable the plugin
openclaw plugins enable startup-suite-channel

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Register a runtime with your Suite deployment:"
echo "     curl -X POST https://suite.milvenan.technology/api/runtimes/register \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"name\": \"my-openclaw-agent\"}'"
echo ""
echo "  2. Edit ~/.openclaw/extensions/startup-suite-channel/config.json"
echo "     with the runtimeId and token from the registration response."
echo ""
echo "  3. Restart OpenClaw to activate the plugin."
