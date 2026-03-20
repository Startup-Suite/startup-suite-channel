import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { SuiteClient } from "./src/suite-client.js";
import { formatAttentionAsMessage } from "./src/message-bridge.js";
import { readFileSync } from "node:fs";
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

const SUITE_SESSION_PREFIX = "suite:";

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
            const sessionKey = bridged.sessionKey;
            const spaceId = sessionKey.replace(SUITE_SESSION_PREFIX, "");

            ctx.logger.info(`[suite] Attention from ${bridged.metadata.author} in space ${spaceId}`);

            // Inject message into OpenClaw agent via subagent.run
            const result = await api.runtime.subagent.run({
              sessionKey,
              message: bridged.message.content,
              deliver: false,
            });

            ctx.logger.info(`[suite] Agent run started: ${result.runId}`);

            // Wait for the agent to finish processing
            const waitResult = await api.runtime.subagent.waitForRun({
              runId: result.runId,
              timeoutMs: 120000,
            });

            if (waitResult.status === "ok") {
              // Retrieve the agent's response
              const session = await api.runtime.subagent.getSessionMessages({
                sessionKey,
                limit: 5,
              });

              const lastAssistant = session.messages
                .reverse()
                .find((m: any) => m.role === "assistant");

              if (lastAssistant && client) {
                const content =
                  typeof lastAssistant.content === "string"
                    ? lastAssistant.content
                    : JSON.stringify(lastAssistant.content);

                client.sendReply(spaceId, content);
                ctx.logger.info(`[suite] Reply sent to space ${spaceId}`);
              }
            } else {
              ctx.logger.warn(`[suite] Agent run failed: ${waitResult.status} ${waitResult.error || ""}`);
            }
          } catch (err: any) {
            ctx.logger.error(`[suite] Error processing attention: ${err.message}`);
          }
        },

        onToolResult(payload) {
          ctx.logger.info(`[suite] Tool result received: ${payload.call_id}`);
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
