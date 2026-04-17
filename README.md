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

## Updating

To update an existing installation after pulling new changes (without touching your config or `openclaw.json`):

```bash
git pull
bash update.sh
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

### Routing accounts to agents

Add `bindings` entries in `openclaw.json` to point each account at a specific OpenClaw agent. There are two important gotchas to get right:

**Gotcha 1: `match.accountId` is required for named accounts.** OpenClaw's router indexes bindings by account. A binding with **no** `match.accountId` is silently filed under `"default"` and only matches inbound events whose account is literally `default`. If you name your accounts (e.g., `beacon`, `sage`, `higgins`), bindings without `accountId` will not match and routing will fall through to the first agent in `agents.list` — usually `main`. Use `accountId: "<account-name>"` or `accountId: "*"` (any account):

```json
{
  "bindings": [
    { "agentId": "beacon-agent", "match": { "channel": "startup-suite", "accountId": "beacon" } },
    { "agentId": "sage-agent",   "match": { "channel": "startup-suite", "accountId": "sage" } }
  ]
}
```

**Gotcha 2: Per-Suite-agent routing** — if several Suite-side agents share one runtime account and you want each routed to a different OpenClaw agent, use peer-matched bindings on the Suite `agent_slug` (available in the attention signal on Suite versions with agent identity packed in — ADR 0034 era). List peer-matched bindings **before** the channel-wildcard fallback:

```json
{
  "bindings": [
    { "agentId": "ops-agent",   "match": { "channel": "startup-suite", "accountId": "*", "peer": { "id": "ops-bot",  "kind": "group" } } },
    { "agentId": "reply-agent", "match": { "channel": "startup-suite", "accountId": "*", "peer": { "id": "concierge", "kind": "group" } } },
    { "agentId": "default-agent","match": { "channel": "startup-suite", "accountId": "*" } }
  ]
}
```

When a Suite agent appears in multiple spaces (chat rooms), the plugin automatically appends the space id to the session key so each room keeps its own conversation history — no cross-space context bleed.

### Configuration reference

| Field | Description | Default |
|---|---|---|
| `url` | Suite WebSocket endpoint | `wss://suite.milvenan.technology/runtime/ws` |
| `runtimeId` | Your registered runtime ID | *(required)* |
| `token` | Authentication token | *(required)* |
| `autoJoinSpaces` | Space IDs to auto-join on connect | `[]` |
| `reconnectIntervalMs` | Initial reconnect delay (ms) | `5000` |
| `maxReconnectIntervalMs` | Max reconnect delay (ms) | `60000` |
| `useMcpTools` | Skip the channel-era `suite_*` tool-name hints in agent prompts and emit MCP-compatible guidance instead. Enable once the agent consumes Suite tools via the `/mcp` endpoint (ADR 0034). | `false` |

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

**All messages route to the first agent in `agents.list` (usually `main`) even though you wrote a binding for another agent**
- Your binding's `match` block is missing `accountId`. OpenClaw's router buckets such bindings under the internal account name `"default"` and will not match inbound events on a named account. Add `"accountId": "<your-account-name>"` (or `"accountId": "*"` to match any account) to each `bindings[].match` entry for this channel. See [Routing accounts to agents](#routing-accounts-to-agents) for full examples.

---

## License

MIT
