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

```bash
git clone https://github.com/Startup-Suite/startup-suite-channel.git
cd startup-suite-channel
bash install.sh
```

The install script copies the plugin to `~/.openclaw/extensions/startup-suite-channel/`, installs dependencies, creates a default `config.json`, and registers the channel in `openclaw.json`.

## Configuration

After install:

1. Register a runtime in Suite (**Agent Resources → Add Agent → Federate**)
2. Copy the `runtime_id` and `token` from Suite
3. Edit `~/.openclaw/extensions/startup-suite-channel/config.json`:

```json
{
  "url": "wss://your-suite.example.com/runtime/ws",
  "runtimeId": "your-runtime-id",
  "token": "your-token"
}
```

4. Test the connection:

```bash
bash scripts/test-connection.sh
```

5. Restart OpenClaw:

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
