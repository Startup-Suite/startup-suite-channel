import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { Type } from "@sinclair/typebox";
import { SuiteClient } from "./src/suite-client.js";
import { formatAttentionAsMessage } from "./src/message-bridge.js";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SuiteConfig {
  url: string;
  runtimeId: string;
  token: string;
  autoJoinSpaces: string[];
  reconnectIntervalMs: number;
  maxReconnectIntervalMs: number;
}

function loadConfig(): SuiteConfig {
  const raw = readFileSync(join(__dirname, "config.json"), "utf-8");
  return JSON.parse(raw);
}

/**
 * Run `openclaw agent` to send a message through the gateway and get a response.
 * This is the same path as CLI usage — fully supported, no internal API guesswork.
 */
function runAgent(message: string, agentId?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["agent", "--message", message, "--json"];
    if (agentId) args.push("--agent", agentId);

    execFile("openclaw", args, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`openclaw agent failed: ${err.message}\nstderr: ${stderr}`));
        return;
      }

      try {
        // stdout may contain log lines before the JSON — find the JSON object
        const jsonStart = stdout.indexOf("{");
        const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
        const result = JSON.parse(jsonStr);

        // Extract reply text from the structured result
        let reply = "";
        if (result.result?.payloads) {
          reply = result.result.payloads
            .map((p: any) => p.text || "")
            .filter(Boolean)
            .join("\n");
        }
        if (!reply) {
          reply = result.reply || result.text || result.content || "";
        }

        resolve(typeof reply === "string" ? reply : JSON.stringify(reply));
      } catch {
        // If not JSON, strip log lines and use remaining stdout
        const lines = stdout.split("\n").filter(
          (l: string) => !l.startsWith("[") && l.trim() !== ""
        );
        resolve(lines.join("\n").trim());
      }
    });
  });
}

// ── Suite tool helpers ──────────────────────────────────────────────

function suiteToolExecute(toolName: string, clientRef: () => SuiteClient | null) {
  return async (_toolCallId: string, params: Record<string, unknown>) => {
    const c = clientRef();
    if (!c) throw new Error("Suite client is not connected");
    const result = await c.callTool(toolName, params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
  };
}

export default function register(api: OpenClawPluginApi) {
  let client: SuiteClient | null = null;
  const getClient = () => client;

  // ── Register Suite tools ────────────────────────────────────────

  api.registerTool({
    name: "suite_canvas_create",
    label: "Create Suite Canvas",
    description:
      "Create a live collaborative canvas in a Startup Suite space. Use when the conversation calls for a shared visual artifact like a table, diagram, dashboard, or code block.",
    parameters: Type.Object({
      space_id: Type.String({ description: "UUID of the Suite space (from the conversation context)" }),
      canvas_type: Type.Union(
        [Type.Literal("table"), Type.Literal("dashboard"), Type.Literal("code"), Type.Literal("diagram"), Type.Literal("custom")],
        { description: "Type of canvas to create" },
      ),
      title: Type.String({ description: "Human-readable title for the canvas" }),
      initial_state: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Initial content for the canvas" })),
    }),
    execute: suiteToolExecute("canvas_create", getClient),
  });

  api.registerTool({
    name: "suite_canvas_update",
    label: "Update Suite Canvas",
    description:
      "Update an existing canvas in a Startup Suite space. Use to modify the content, title, or state of a canvas that was previously created.",
    parameters: Type.Object({
      space_id: Type.String({ description: "UUID of the Suite space" }),
      canvas_id: Type.String({ description: "UUID of the canvas to update" }),
      updates: Type.Record(Type.String(), Type.Unknown(), { description: "Fields to update on the canvas (e.g. title, state)" }),
    }),
    execute: suiteToolExecute("canvas_update", getClient),
  });

  api.registerTool({
    name: "suite_task_create",
    label: "Create Suite Task",
    description:
      "Create a task in a Startup Suite space. Use when the user requests a tracked to-do, action item, or work item.",
    parameters: Type.Object({
      space_id: Type.String({ description: "UUID of the Suite space" }),
      title: Type.String({ description: "Title / summary of the task" }),
      description: Type.Optional(Type.String({ description: "Longer description or acceptance criteria" })),
      assignee_id: Type.Optional(Type.String({ description: "UUID of the participant to assign this task to" })),
    }),
    execute: suiteToolExecute("task_create", getClient),
  });

  api.registerTool({
    name: "suite_task_complete",
    label: "Complete Suite Task",
    description:
      "Mark an existing task as done in a Startup Suite space.",
    parameters: Type.Object({
      space_id: Type.String({ description: "UUID of the Suite space" }),
      task_id: Type.String({ description: "UUID of the task to mark complete" }),
    }),
    execute: suiteToolExecute("task_complete", getClient),
  });

  api.registerService({
    id: "suite-connection",
    name: "Suite WebSocket Connection",

    async start(ctx) {
      const config = loadConfig();

      client = new SuiteClient(config, {
        async onAttention(payload) {
          try {
            const bridged = formatAttentionAsMessage(payload);
            const spaceId = bridged.sessionKey.replace("suite:", "");

            ctx.logger.info(`[suite] Attention from ${bridged.metadata.author} in space ${spaceId}`);

            // Run the agent via openclaw CLI — fully supported, battle-tested path
            try {
              const reply = await runAgent(bridged.message.content, "main");

              if (reply && client) {
                client.sendReply(spaceId, reply);
                ctx.logger.info(`[suite] Reply sent to space ${spaceId} (${reply.length} chars)`);
              } else {
                ctx.logger.warn(`[suite] No reply from agent`);
                if (client) {
                  client.sendReply(spaceId, "_Agent produced no response._");
                }
              }
            } catch (agentErr: any) {
              const errMsg = agentErr.message || "Unknown error";
              ctx.logger.error(`[suite] Agent error: ${errMsg}`);

              // Parse common error patterns
              let userMessage = "I encountered an error processing your message.";
              if (errMsg.includes("401") || errMsg.includes("Unauthorized")) {
                userMessage = "Authentication error with the model provider. The runtime admin needs to check API keys.";
              } else if (errMsg.includes("429") || errMsg.includes("rate limit") || errMsg.includes("Too Many")) {
                userMessage = "Rate limited by the model provider. Please try again in a moment.";
              } else if (errMsg.includes("503") || errMsg.includes("529") || errMsg.includes("overloaded")) {
                userMessage = "The model provider is currently overloaded. Please try again shortly.";
              } else if (errMsg.includes("timeout")) {
                userMessage = "The request timed out. Please try again.";
              }

              if (client) {
                client.sendReply(spaceId, `⚠️ ${userMessage}`);
              }
            }
          } catch (err: any) {
            ctx.logger.error(`[suite] Error: ${err.message}`);
            console.error(`[suite] Error:`, err);
          }
        },

        onToolResult(payload) {
          ctx.logger.info(`[suite] Tool result: ${payload.call_id}`);
        },

        onDisconnect() {
          ctx.logger.warn("[suite] Connection lost, reconnecting...");
        },
      });

      client.connect();
      ctx.logger.info(`[suite] Connected to Suite as runtime ${config.runtimeId}`);
    },

    async stop() {
      if (client) {
        client.disconnect();
        client = null;
      }
    },
  });
}
