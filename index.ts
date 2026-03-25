import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { suitePlugin } from "./src/channel.js";
import { clientForSpace, getTaskWorkers } from "./src/plugin-state.js";
import { setSuiteRuntime } from "./src/runtime.js";
import { parseTaskSessionKey } from "./src/session-key.js";

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-opus-4": { input: 5.0, output: 25.0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(MODEL_PRICING).find((k) => model.includes(k)) || "";
  const pricing = MODEL_PRICING[key];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

function resolveSpaceId(sessionKey?: string | null): string | undefined {
  const taskSession = parseTaskSessionKey(sessionKey);
  if (taskSession) {
    return getTaskWorkers().resolveExecutionSpaceId(sessionKey);
  }

  const parts = (sessionKey || "").split(":");
  return parts.length >= 5 ? parts[4] : parts.length >= 4 ? parts[3] : undefined;
}

export default defineChannelPluginEntry({
  id: "startup-suite-channel-plugin",
  name: "Startup Suite Channel",
  description: "Connect OpenClaw to a Startup Suite deployment as a federated runtime",
  plugin: suitePlugin,
  setRuntime: setSuiteRuntime,
  registerFull(api) {
    api.on("llm_output", (event, ctx) => {
      if (!ctx.channelId?.includes("startup-suite") && !ctx.sessionKey?.includes("startup-suite")) {
        return;
      }

      const taskSession = parseTaskSessionKey(ctx.sessionKey);
      const spaceId = resolveSpaceId(ctx.sessionKey);
      const client = clientForSpace(spaceId);
      if (!client) return;

      if (taskSession) {
        getTaskWorkers().noteProgress(taskSession.taskId, taskSession.phase, "llm turn completed");
      }

      const usage = event.usage || {};
      const inputTokens = usage.input || 0;
      const outputTokens = usage.output || 0;
      const costUsd = estimateCost(event.model || "", inputTokens, outputTokens);

      client.sendUsageEvent({
        space_id: spaceId,
        session_key: ctx.sessionKey,
        model: event.model,
        provider: event.provider,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: usage.cacheRead || 0,
        cache_write_tokens: usage.cacheWrite || 0,
        cost_usd: costUsd,
        latency_ms: 0,
        metadata: {
          session_id: event.sessionId || ctx.sessionId,
          run_id: event.runId,
        },
      });
    });
  },
});
