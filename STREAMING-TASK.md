# Task: Add Response Streaming from OpenClaw to Startup Suite

## Goal
Stream agent responses progressively to Suite chat instead of waiting for the full reply. When the agent is generating a response, users should see text appear incrementally.

## Architecture

### Current Flow (no streaming)
```
User message → Suite → RuntimeChannel → Plugin (attention) → OpenClaw agent pipeline
→ agent generates full reply → deliver callback → plugin.sendReply(spaceId, fullText)
→ Suite RuntimeChannel → ChatLive → rendered message
```

### Target Flow (with streaming)
```
User message → Suite → RuntimeChannel → Plugin (attention) → OpenClaw agent pipeline
→ agent starts generating → onAgentEvent listener catches assistant chunks
→ plugin pushes "reply_chunk" events to Suite via WebSocket
→ RuntimeChannel forwards to ChatLive via PubSub
→ ChatLive accumulates chunks and renders progressive text
→ final deliver callback sends complete message (replaces streaming placeholder)
```

## Implementation Plan

### Part 1: Plugin Side (`startup-suite-channel`)

#### 1a. Hook into the deliver callback in `inbound.ts`

**IMPORTANT**: `onAgentEvent` from `openclaw/plugin-sdk/infra/agent-events` is NOT accessible from external plugins — the subpath is not exported in package.json and the function is bundled into an internal chunk. Do NOT try to import it.

**Approach**: The `deliver` callback in `dispatchInboundReplyWithBase` is called once per reply block. For multi-block responses (tool calls then final text), it may be called multiple times. We use this as our streaming hook:

1. Before calling `dispatchInboundReplyWithBase`, push a `typing` event with `typing: true` to Suite
2. The `deliver` callback receives each block — push `reply_chunk` events for each
3. After dispatch completes, send `typing: false`

This gives block-level streaming (not token-level). For token-level streaming in the future, we'd need OpenClaw to expose `onAgentEvent` to external plugins.

Additionally, wrap the deliver callback to push intermediate content to Suite as `reply_chunk` events, allowing the UI to show progressive text.

#### 1b. Add `sendReplyChunk` to `SuiteClient` (`suite-client.ts`)
- New method: `sendReplyChunk(spaceId: string, chunkId: string, text: string, done: boolean)`
- Pushes a `"reply_chunk"` event on the Phoenix channel
- `chunkId` groups chunks for the same reply (use runId or generated ID)
- `done: true` signals the final chunk

#### 1c. Throttle chunk delivery
- Don't send every token — batch into ~200ms windows
- Accumulate text, flush on timer or when done
- This prevents flooding the WebSocket

### Part 2: Suite Side (`Startup-Suite/core`)

#### 2a. Handle `reply_chunk` in RuntimeChannel (`runtime_channel.ex`)
- New `handle_in("reply_chunk", ...)` clause
- Validate: space_id, chunk_id, text, done flag
- Resolve agent participant (same as reply handler)
- Broadcast `{:agent_reply_chunk, %{space_id, chunk_id, text, done, participant_id}}` via PubSub

#### 2b. Accumulate chunks in ChatLive (`chat_live.ex`)
- New assign: `streaming_replies` — map of `chunk_id => %{text: accumulated_text, participant_id: pid}`
- `handle_info({:agent_reply_chunk, payload})`:
  - If `done: false`: append text to accumulator, render as a "typing" message bubble
  - If `done: true`: clear the accumulator (the final complete message will arrive via normal reply path)
- Render streaming text in the message list as a special ephemeral bubble (similar to the typing indicator but with actual text content)

#### 2c. Streaming message bubble UI
- Below the last message, show a bubble when `@streaming_replies` is non-empty
- Render the accumulated text with a subtle pulsing cursor/indicator
- When the final message arrives via normal `{:new_message, msg}`, remove the streaming bubble
- Use the same sender avatar/name as the agent

### Part 3: Testing
- Test locally with the dev federation setup
- Verify chunks appear progressively
- Verify final message replaces streaming bubble
- Verify no duplicate messages
- Test with multiple spaces (chunk routing)

## Key Files
- `sources/startup-suite-channel/src/inbound.ts` — dispatch + event listener
- `sources/startup-suite-channel/src/suite-client.ts` — WebSocket methods
- `sources/startup-suite-channel/src/channel.ts` — plugin registration
- `apps/platform/lib/platform_web/channels/runtime_channel.ex` — WS handler
- `apps/platform/lib/platform_web/live/chat_live.ex` — LiveView rendering
- `apps/platform/lib/platform/chat/pubsub.ex` — PubSub broadcasts

## Constraints
- Don't break the existing full-reply path — streaming is additive
- The final complete message must still be posted as a real DB-persisted message
- Streaming bubbles are ephemeral (client-side only, not persisted)
- Handle reconnection gracefully — if connection drops during streaming, the final message still arrives via normal path
