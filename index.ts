import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { suitePlugin } from "./src/channel.js";
import { clientForSpace, clearSessionContext, getSessionContext, getTaskWorkers } from "./src/plugin-state.js";
import { setSuiteRuntime } from "./src/runtime.js";
import { parseTaskSessionKey } from "./src/session-key.js";
import { formatContextPreamble } from "./src/message-bridge.js";
import type { AttentionPayload } from "./src/suite-client.js";

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

function taskPhaseGuidance(taskSession: ReturnType<typeof parseTaskSessionKey>): string | null {
  if (!taskSession) return null;

  const common = [
    "You are in an orchestrated Startup Suite task session.",
    `Current task phase: ${taskSession.phase}.`,
    "Treat the most recent inbound task payload as the authoritative objective and context.",
    "If the dispatch payload includes attached skills or bundled skill content, treat that payload content as the authoritative skill guidance for this task before trying to rediscover skills from disk.",
    "If a task/stage references paths under skills/... , resolve them from the active workspace root for this runtime rather than assuming they live under the npm-installed OpenClaw skill directory.",
    "You may use memory, skills, and broader project context if they are genuinely helpful, but do not spend your first turn on generic re-orientation when the current task payload already gives you enough to act.",
    "Prefer completing the assigned phase promptly. If you cannot complete it with the available context/tools, report a blocker instead of drifting.",
  ];

  const phaseSpecific: Record<string, string[]> = {
    planning: [
      "For planning turns, the expected happy path is to create and submit a plan promptly.",
      "Preferred tool sequence: suite_plan_create -> suite_plan_submit.",
      "Only fetch extra task/project context if it is necessary to produce a materially better plan.",
      "If you still cannot produce a viable plan, call report_blocker with a concrete reason.",
    ],
    execution: [
      "For execution turns, prioritize making progress on the current stage.",
      "Preferred outcome: complete the stage and call stage_complete, or call report_blocker with a concrete reason.",
      "Do not treat the session like a fresh chat; act on the current stage objective first.",
      "If the current stage already names concrete scripts, files, directories, or tool calls, start there instead of re-fetching broad task/project context.",
      "Avoid redundant suite_task_get/suite_plan_get/task-listing calls on the first turn unless you are missing a required identifier or the stage contract is genuinely ambiguous.",
      "If an attached or bundled skill is relevant (for example Suite Coding Agent), use the attached skill guidance or the workspace-local skill path first; do not invent a different installed-skill path.",
      "If a stage description includes explicit stage_id/task_id arguments or a concrete evidence path, use those exact values directly.",
    ],
    review: [
      "For review turns, prioritize producing review evidence, creating any required review request, and driving validations to a concrete result.",
      "If the stage or validation requires manual approval, your first success path is: publish evidence (including a canvas/screenshot when appropriate) -> call suite_review_request_create -> wait for human feedback or report_blocker.",
      "Do NOT call stage_complete before the required manual-review request and evidence have been created.",
      "Preferred outcome: submit the required review artifact/validation result, or call report_blocker with a concrete reason.",
    ],
  };

  return [...common, ...(phaseSpecific[taskSession.phase] ?? [])].join("\n");
}

export default defineChannelPluginEntry({
  id: "startup-suite-channel-plugin",
  name: "Startup Suite Channel",
  description: "Connect OpenClaw to a Startup Suite deployment as a federated runtime",
  plugin: suitePlugin,
  setRuntime: setSuiteRuntime,
  registerFull(api) {
    api.on("before_prompt_build", (_event, ctx) => {
      const segments: string[] = [];

      const context = getSessionContext(ctx.sessionKey);
      if (context) {
        const preamble = formatContextPreamble(context as AttentionPayload["context"]);
        if (preamble) segments.push(preamble);
      }

      const taskSession = parseTaskSessionKey(ctx.sessionKey);
      const guidance = taskPhaseGuidance(taskSession);
      if (guidance) segments.push(`TASK MODE\n${guidance}`);

      if (segments.length === 0) return;
      return { prependSystemContext: segments.join("\n\n") };
    });

    api.on("session_start", (event, ctx) => {
      const taskSession = parseTaskSessionKey(ctx.sessionKey ?? event.sessionKey);
      if (!taskSession) return;
      getTaskWorkers().noteSessionStarted(taskSession.taskId, taskSession.phase, {
        sessionId: event.sessionId,
        sessionKey: ctx.sessionKey ?? event.sessionKey,
      });
    });

    api.on("session_end", (_event, ctx) => {
      if (ctx.sessionKey) clearSessionContext(ctx.sessionKey);
    });

    api.on("llm_input", (event, ctx) => {
      const taskSession = parseTaskSessionKey(ctx.sessionKey);
      if (!taskSession) return;
      getTaskWorkers().notePromptDelivered(taskSession.taskId, taskSession.phase, {
        sessionId: event.sessionId,
        runId: event.runId,
        sessionKey: ctx.sessionKey,
        summary: "task prompt delivered to agent",
      });
    });

    api.on("after_tool_call", (event, ctx) => {
      const taskSession = parseTaskSessionKey(ctx.sessionKey);
      if (!taskSession) return;

      const details = {
        sessionId: ctx.sessionId,
        runId: ctx.runId ?? event.runId,
        sessionKey: ctx.sessionKey,
      };

      const toolName = event.toolName;
      if (event.error) {
        if (["suite_plan_create", "suite_plan_submit", "stage_complete", "report_blocker"].includes(toolName)) {
          getTaskWorkers().noteProgress(
            taskSession.taskId,
            taskSession.phase,
            `${toolName} failed; agent may retry`,
            {
              ...details,
              idempotencyKey: `${taskSession.taskId}:${taskSession.phase}:tool-error:${toolName}:${details.runId ?? details.sessionId ?? taskSession.taskId}`,
            }
          );
        }
        return;
      }

      if (toolName === "suite_plan_create") {
        getTaskWorkers().noteProgress(taskSession.taskId, taskSession.phase, "plan created", {
          ...details,
          idempotencyKey: `${taskSession.taskId}:${taskSession.phase}:tool:suite_plan_create:${details.runId ?? details.sessionId ?? taskSession.taskId}`,
        });
        return;
      }

      if (toolName === "suite_plan_submit") {
        getTaskWorkers().noteFinished(taskSession.taskId, taskSession.phase, "plan submitted for review", {
          ...details,
          idempotencyKey: `${taskSession.taskId}:${taskSession.phase}:tool:suite_plan_submit:${details.runId ?? details.sessionId ?? taskSession.taskId}`,
        });
        return;
      }

      if (toolName === "suite_review_request_create") {
        getTaskWorkers().noteProgress(taskSession.taskId, taskSession.phase, "review request created", {
          ...details,
          idempotencyKey: `${taskSession.taskId}:${taskSession.phase}:tool:suite_review_request_create:${details.runId ?? details.sessionId ?? taskSession.taskId}`,
        });
        return;
      }

      if (toolName === "stage_complete") {
        getTaskWorkers().noteFinished(taskSession.taskId, taskSession.phase, "stage completed", {
          ...details,
          idempotencyKey: `${taskSession.taskId}:${taskSession.phase}:tool:stage_complete:${details.runId ?? details.sessionId ?? taskSession.taskId}`,
        });
        return;
      }

      if (toolName === "report_blocker") {
        getTaskWorkers().noteBlocked(taskSession.taskId, taskSession.phase, "blocker reported", {
          ...details,
          idempotencyKey: `${taskSession.taskId}:${taskSession.phase}:tool:report_blocker:${details.runId ?? details.sessionId ?? taskSession.taskId}`,
        });
        return;
      }

      if (toolName === "suite_validation_evaluate") {
        getTaskWorkers().noteProgress(taskSession.taskId, taskSession.phase, "validation submitted", {
          ...details,
          idempotencyKey: `${taskSession.taskId}:${taskSession.phase}:tool:suite_validation_evaluate:${details.runId ?? details.sessionId ?? taskSession.taskId}`,
        });
      }
    });

    api.on("llm_output", (event, ctx) => {
      if (!ctx.channelId?.includes("startup-suite") && !ctx.sessionKey?.includes("startup-suite")) {
        return;
      }

      const taskSession = parseTaskSessionKey(ctx.sessionKey);
      const spaceId = resolveSpaceId(ctx.sessionKey);
      const client = clientForSpace(spaceId);
      if (!client) return;

      if (taskSession) {
        getTaskWorkers().noteProgress(taskSession.taskId, taskSession.phase, "llm turn completed", {
          sessionId: event.sessionId || ctx.sessionId,
          runId: event.runId,
          sessionKey: ctx.sessionKey,
          idempotencyKey: `${taskSession.taskId}:${taskSession.phase}:llm_output:${event.runId ?? event.sessionId ?? taskSession.taskId}`,
        });
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

    api.on("agent_end", (event, ctx) => {
      const taskSession = parseTaskSessionKey(ctx.sessionKey);
      if (!taskSession || event.success) return;
      getTaskWorkers().noteFailure(
        taskSession.taskId,
        taskSession.phase,
        event.error || "agent run failed",
        {
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
        }
      );
    });
  },
});
