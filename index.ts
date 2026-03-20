import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
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

export default function register(api: OpenClawPluginApi) {
  let client: SuiteClient | null = null;

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
