# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An OpenClaw channel plugin that connects OpenClaw agents to Startup Suite as federated runtimes. The plugin opens an outbound WebSocket (Phoenix channel) to Suite, receives "attention" events (chat messages or task orchestration dispatches), translates them into OpenClaw agent sessions, and streams replies back. All connections are outbound — no port forwarding needed.

## Commands

```bash
npm run build          # TypeScript compile (tsc) → dist/
npm run test:tool-contract  # Verify channel.ts agentTools ↔ suite-client.ts registered list are in sync
```

There is no test suite beyond the tool contract check. No linter is configured.

After building, restart OpenClaw to pick up changes: `openclaw gateway restart`

## Architecture

### Data Flow

```
Suite (Phoenix WS) → SuiteClient.onAttention → handleSuiteInbound → OpenClaw agent pipeline → SuiteClient.sendReply/sendReplyChunk
```

### Key Modules

- **`index.ts`** — Plugin entry point (`defineChannelPluginEntry`). Registers lifecycle hooks (`before_prompt_build`, `session_start`, `llm_input`, `after_tool_call`, `llm_output`, `agent_end`) that inject task-phase steering and relay execution telemetry via TaskWorkerController. Also estimates LLM cost and sends usage events.

- **`src/channel.ts`** — The `ChannelPlugin` definition. Contains all `agentTools` (Suite tools exposed to the agent), outbound reply delivery, account config resolution, and the `gateway.startAccount` lifecycle that creates a SuiteClient per account.

- **`src/suite-client.ts`** — WebSocket transport layer. Wraps a Phoenix `Socket`/channel for the `runtime:<id>` topic. Handles connect/disconnect/reconnect with exponential backoff, message deduplication, and a promise-based `callTool` method with 30s timeout for tool call → tool_result round-trips.

- **`src/inbound.ts`** — Inbound message handler (`handleSuiteInbound`). Classifies signals as chat vs orchestrated task, builds enriched context, resolves agent routing, manages task session keys (fresh sessions per phase/review attempt), and dispatches through the OpenClaw reply pipeline with token-level streaming chunks.

- **`src/task-worker-controller.ts`** — Tracks active task workers per `taskId:phase`. Publishes execution lifecycle events (accepted, started, progress, heartbeat, blocked, finished, failed, abandoned) to Suite. Handles idempotency keys, heartbeat timers, progress throttling, and automatic phase transitions.

- **`src/message-bridge.ts`** — Formats Suite context (space, project, epic, task, plan, skills, canvases) into a markdown preamble prepended to agent messages.

- **`src/plugin-state.ts`** — Singleton state: client registry (accountId → SuiteClient), space→account mapping, legacy config.json fallback, and TaskWorkerController lifecycle.

- **`src/session-key.ts`** — Builds and parses session keys in the format `startup-suite:task:<taskId>:<phase>[:attempt:<n>]`.

### Tool Registration Pattern

Every Suite tool in `channel.ts` `agentTools` uses `suiteToolExecute(serverToolName)` which calls `SuiteClient.callTool` over the WebSocket. Many tools have both a `suite_`-prefixed canonical name and a short alias (e.g., `suite_space_get_context` / `space_get_context`). Both the agentTools array and the `registered` list in `suite-client.ts` must stay in sync — `scripts/check-tool-contract.mjs` enforces this.

### Task Session Lifecycle

Orchestrated tasks flow through phases: `planning → execution → review → deploying`. Each phase gets an isolated session key. Review phases always get a fresh session (timestamped attempt). The TaskWorkerController auto-finishes workers from prior phases when a new phase starts.

### Configuration

Single-agent: `config.json` at the plugin root (legacy path, loaded by plugin-state as fallback).
Multi-agent: Named accounts under `channels.startup-suite.accounts` in OpenClaw's `openclaw.json`.
