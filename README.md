# Startup Suite Channel Plugin for OpenClaw

Connect an OpenClaw instance to a [Startup Suite](https://suite.milvenan.technology) deployment, allowing the OpenClaw agent to participate in Suite spaces as a federated runtime.

## Architecture

OpenClaw connects **outbound** to Suite's Phoenix Socket endpoint (`/runtime/ws`). This means Suite must be publicly reachable, but OpenClaw can run behind NAT without any port forwarding.

```
OpenClaw  ──WebSocket──▶  Suite /runtime/ws
          ◀─attention────
          ──reply───────▶
          ──typing──────▶
          ──tool_call───▶
```

The connection authenticates using a `runtime_id` and `token` pair. After connecting, the client joins the `runtime:<runtime_id>` channel and listens for `attention` events containing context bundles from Suite spaces.

## Prerequisites

- OpenClaw installed and running
- A Suite deployment with a registered runtime
- Node.js 18+

## Installation

```bash
git clone <this-repo>
cd startup-suite-channel
chmod +x install.sh
./install.sh
```

Or manually:

1. Copy files to `~/.openclaw/extensions/startup-suite-channel/`
2. Run `npm install` in that directory
3. Copy `config.example.json` to `config.json` and fill in credentials
4. Run `openclaw plugins enable startup-suite-channel`

## Configuration

Edit `~/.openclaw/extensions/startup-suite-channel/config.json`:

| Field | Description | Default |
|---|---|---|
| `url` | Suite WebSocket endpoint | `wss://suite.milvenan.technology/runtime/ws` |
| `runtimeId` | Your registered runtime ID | *(required)* |
| `token` | Authentication token | *(required)* |
| `autoJoinSpaces` | Space IDs to auto-join | `[]` |
| `reconnectIntervalMs` | Initial reconnect delay (ms) | `5000` |
| `maxReconnectIntervalMs` | Max reconnect delay (ms) | `60000` |

**Note:** `config.json` contains your secret token. It is excluded from version control via `.gitignore`.

## Registering a Runtime with Suite

Before using this plugin, register a runtime with your Suite deployment:

```bash
curl -X POST https://suite.milvenan.technology/api/runtimes/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-openclaw-agent"}'
```

The response will contain `runtime_id` and `token` — add these to your `config.json`.

## How It Works

1. The plugin opens a WebSocket to Suite and joins the runtime channel
2. Suite pushes **attention** events when the agent is mentioned or needed in a space
3. Each attention event includes the message, conversation history, space context (canvases, tasks, agents), and available tools
4. The message bridge translates this into an OpenClaw agent session
5. Agent responses are sent back to Suite as replies

## Troubleshooting

**Connection refused**
- Verify the `url` in config.json is correct and the Suite server is reachable
- Check that the Suite deployment has the `/runtime/ws` endpoint enabled

**Authentication failed**
- Ensure `runtimeId` and `token` match the values from runtime registration
- The token may have expired — re-register with Suite if needed

**Disconnects / reconnection loops**
- The plugin uses exponential backoff (starting at `reconnectIntervalMs`, up to `maxReconnectIntervalMs`)
- Check Suite server logs for disconnect reasons
- Network issues between OpenClaw and Suite will cause reconnection attempts

**No attention events received**
- Verify the runtime is associated with at least one Suite space
- Check that the agent is mentioned or configured for auto-attention in the space

## License

MIT
