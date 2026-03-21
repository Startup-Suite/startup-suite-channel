# Startup Suite Channel Plugin for OpenClaw

Connect your OpenClaw agent to a Startup Suite deployment as a federated runtime. Your agent participates in Suite spaces — receiving messages, responding through the OpenClaw channel pipeline, and calling Suite tools (canvas, tasks). The connection is outbound-only, so OpenClaw can run behind NAT without port forwarding.

## Architecture

```
Your OpenClaw (behind NAT) ──outbound WSS──► Startup Suite (public)
                                                  │
                              ◄── attention signals + context ──┘
                              ──► agent replies ────────────────►
                              ◄── tool results ─────────────────┘
                              ──► tool calls ───────────────────►
```

After connecting, the plugin joins a Phoenix channel (`runtime:<id>`) and listens for **attention** events. Each event includes the triggering message, conversation history, space context (canvases, tasks, participants), and available tools. The message bridge translates this into an OpenClaw agent session, and replies flow back to Suite.

## Prerequisites

- OpenClaw 2026.2.0+ installed and running
- A Startup Suite deployment with a registered runtime (get this from Suite's **Agent Resources → Federate**)
- Node.js 18+

## Installation

First, register a runtime in Suite: **Agent Resources → Add Agent → Federate**. Copy the runtime ID and token.

### Interactive (recommended)

```bash
git clone https://github.com/Startup-Suite/startup-suite-channel.git
cd startup-suite-channel
bash install.sh
```

The script will prompt for your runtime ID and token, then handle everything: file copy, npm install, config, and OpenClaw registration.

### Non-interactive

```bash
bash install.sh --runtime-id my-runtime --token abc123def456
```

With a custom Suite URL:

```bash
bash install.sh \
  --url wss://suite.example.com/runtime/ws \
  --runtime-id my-runtime \
  --token abc123def456
```

### What the installer does

1. Copies plugin files to `~/.openclaw/extensions/startup-suite-channel/`
2. Installs npm dependencies
3. Writes `config.json` with your runtime credentials
4. Registers the channel and plugin in `openclaw.json`
5. Optionally tests the connection

After install, restart OpenClaw:

```bash
openclaw gateway restart
```

### Configuration Reference

| Field | Description | Default |
|---|---|---|
| `url` | Suite WebSocket endpoint | `wss://suite.milvenan.technology/runtime/ws` |
| `runtimeId` | Your registered runtime ID | *(required)* |
| `token` | Authentication token | *(required)* |
| `autoJoinSpaces` | Space IDs to auto-join on connect | `[]` |
| `reconnectIntervalMs` | Initial reconnect delay (ms) | `5000` |
| `maxReconnectIntervalMs` | Max reconnect delay (ms) | `60000` |

## Security

- All connections are **outbound** from OpenClaw (NAT-safe, no port forwarding needed)
- The runtime token authenticates the WebSocket connection to Suite
- Suite handles user authentication via OIDC
- Messages only route from authenticated Suite users in spaces the agent has joined
- The `token` in `config.json` is sensitive — treat it like an API key

## Uninstall

```bash
cd startup-suite-channel
bash uninstall.sh
openclaw gateway restart
```

This removes the extension directory and cleans up `openclaw.json`.

## Suite Tools

The plugin registers these tools for the agent:

| Tool | Description |
|---|---|
| `suite_canvas_create` | Create a collaborative canvas in a Suite space |
| `suite_canvas_update` | Update an existing canvas |
| `suite_task_create` | Create a task in a Suite space |
| `suite_task_complete` | Mark a task as done |

## Troubleshooting

**Connection refused**
- Check that Suite is running and the `url` in config.json is correct
- Verify the `/runtime/ws` endpoint is reachable from your network

**Auth failed**
- Verify `runtimeId` and `token` match what Suite generated
- The token may have expired — re-register with Suite if needed

**No responses**
- Check OpenClaw gateway logs for errors: `openclaw gateway logs`
- Ensure the runtime is associated with at least one Suite space

**Duplicate messages**
- Restart OpenClaw gateway to clear stale connections: `openclaw gateway restart`

## License

MIT
