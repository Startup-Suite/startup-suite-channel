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
        const result = JSON.parse(stdout);
        const reply = result.reply || result.text || result.content || "";
        resolve(typeof reply === "string" ? reply : JSON.stringify(reply));
      } catch {
        // If not JSON, use stdout directly (non --json fallback)
        resolve(stdout.trim());
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
            const reply = await runAgent(bridged.message.content, "main");

            if (reply && client) {
              client.sendReply(spaceId, reply);
              ctx.logger.info(`[suite] Reply sent to space ${spaceId} (${reply.length} chars)`);
            } else {
              ctx.logger.warn(`[suite] No reply from agent`);
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
