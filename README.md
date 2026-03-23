# Startup Suite Channel Plugin for OpenClaw

Connect your OpenClaw agent to a Startup Suite deployment as a federated runtime. Your agent participates in Suite spaces — receiving messages, responding through the OpenClaw channel pipeline, and calling Suite tools (canvas, tasks, plans). The connection is outbound-only, so OpenClaw can run behind NAT without port forwarding.

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
3. Writes `config.json` with your runtime credentials (single-account default)
4. Registers the channel and plugin in `openclaw.json`
5. Optionally tests the connection

After install, restart OpenClaw:

```bash
openclaw gateway restart
```

---

## Configuration

### Single agent (simple — uses config.json)

The installer writes a `config.json` for the default account. No `openclaw.json` changes needed beyond what the installer does.

```json
{
  "url": "wss://suite.milvenan.technology/runtime/ws",
  "runtimeId": "my-agent-runtime-id",
  "token": "my-token",
  "autoJoinSpaces": [],
  "reconnectIntervalMs": 5000,
  "maxReconnectIntervalMs": 60000
}
```

### Multiple agents on one gateway

If you have multiple federated agents (e.g., Beacon + Sage) running from the same OpenClaw gateway, configure them as named accounts in `openclaw.json` instead of using separate plugin instances (which would cause duplicate tool registration errors).

Add the following to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "startup-suite": {
      "accounts": {
        "beacon": {
          "url": "wss://suite.milvenan.technology/runtime/ws",
          "runtimeId": "beacon-runtime-uuid",
          "token": "beacon-token"
        },
        "sage": {
          "url": "wss://suite.milvenan.technology/runtime/ws",
          "runtimeId": "sage-runtime-uuid",
          "token": "sage-token"
        }
      }
    }
  }
}
```

Each named account becomes a separate WebSocket connection. Tools register once globally — no conflicts regardless of how many accounts are configured.

**Agent routing:** Each account routes to its own OpenClaw agent via the standard `agents.list` routing config. By default, all accounts route to the default agent. To route accounts to specific agents, configure your agent routing in `openclaw.json`.

### Configuration reference

| Field | Description | Default |
|---|---|---|
| `url` | Suite WebSocket endpoint | `wss://suite.milvenan.technology/runtime/ws` |
| `runtimeId` | Your registered runtime ID | *(required)* |
| `token` | Authentication token | *(required)* |
| `autoJoinSpaces` | Space IDs to auto-join on connect | `[]` |
| `reconnectIntervalMs` | Initial reconnect delay (ms) | `5000` |
| `maxReconnectIntervalMs` | Max reconnect delay (ms) | `60000` |

---

## Suite Tools

The plugin registers these tools for the agent:

### Canvas

| Tool | Description |
|---|---|
| `suite_canvas_create` | Create a collaborative canvas (table, code, diagram, dashboard) in a Suite space |
| `suite_send_media` | Send a message with file attachments into a Suite space |

### Tasks

| Tool | Description |
|---|---|
| `suite_project_list` | List all projects |
| `suite_epic_list` | List epics, optionally filtered by project |
| `suite_task_create` | Create a task on the kanban board |
| `suite_task_get` | Get a task by ID |
| `suite_task_list` | List tasks with optional filters (project, epic, status) |
| `suite_task_update` | Update a task (title, description, status, priority, epic) |

### Plans & Execution

| Tool | Description |
|---|---|
| `suite_plan_create` | Create an ordered plan (stages + validations) for a task |
| `suite_plan_get` | Get the current approved plan for a task with stage/validation status |
| `suite_plan_submit` | Submit a draft plan for human review |
| `suite_stage_start` | Start a stage (pending → running) |
| `suite_stage_list` | List all stages for a plan |
| `suite_validation_evaluate` | Submit a pass/fail result for a validation check |
| `suite_validation_list` | List all validations for a stage |

### Task lifecycle

Tasks move through a validated state machine. Not all transitions are allowed:

```
backlog → planning → ready → in_progress → in_review → done
           ↕           ↕          ↕              ↕
         blocked ←──────────────────────────────┘
```

Plans flow through their own lifecycle:

```
draft → pending_review → approved → executing → completed
                       → rejected
```

Stages within an approved plan:

```
pending → running → passed
                  → failed → running (retry)
                           → skipped
```

The plan engine advances stages automatically when all validations on a stage resolve as passed.

---

## Security

- All connections are **outbound** from OpenClaw (NAT-safe, no port forwarding needed)
- The runtime token authenticates the WebSocket connection to Suite
- Suite handles user authentication via OIDC
- Messages only route from authenticated Suite users in spaces the agent has joined
- `token` values are sensitive — treat them like API keys; do not commit to source control

---

## Uninstall

```bash
cd startup-suite-channel
bash uninstall.sh
openclaw gateway restart
```

This removes the extension directory and cleans up `openclaw.json`.

---

## Troubleshooting

**Connection refused**
- Check that Suite is running and the URL is correct
- Verify the `/runtime/ws` endpoint is reachable from your network

**Auth failed**
- Verify `runtimeId` and `token` match what Suite generated
- The token may have expired — re-register with Suite if needed

**No responses**
- Check OpenClaw gateway logs: `openclaw gateway logs`
- Ensure the runtime is associated with at least one Suite space

**Duplicate tool registration errors (multi-agent setup)**
- Do not run multiple plugin instances — use the multi-account config in `openclaw.json` instead (see above)
- If you previously had a `startup-suite-beacon` plugin, remove it; its tools are already registered by this plugin

**Duplicate messages**
- Restart OpenClaw gateway to clear stale connections: `openclaw gateway restart`

---

## License

MIT
