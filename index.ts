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

export default function register(api: OpenClawPluginApi) {
  let client: SuiteClient | null = null;

  api.registerService({
    id: "suite-connection",
    name: "Suite WebSocket Connection",

    async start() {
      const config = loadConfig();

      client = new SuiteClient(config, {
        onAttention(payload) {
          const { sessionKey, message, metadata } = formatAttentionAsMessage(payload);
          api.injectMessage(sessionKey, message, metadata);
        },

        onToolResult(payload) {
          api.resolveToolCall(payload.call_id, payload.result);
        },

        onDisconnect() {
          api.log("warn", "Suite connection lost, reconnecting...");
        },
      });

      client.connect();
      api.log("info", `Connected to Suite as runtime ${config.runtimeId}`);
    },

    async stop() {
      if (client) {
        client.disconnect();
        client = null;
      }
    },
  });

  api.registerChannel({
    id: "suite",
    name: "Startup Suite",

    async sendReply(sessionKey: string, content: string) {
      if (!client) return;
      const spaceId = sessionKey.replace(/^suite:/, "");
      client.sendReply(spaceId, content);
    },

    async sendTyping(sessionKey: string, typing: boolean) {
      if (!client) return;
      const spaceId = sessionKey.replace(/^suite:/, "");
      client.sendTyping(spaceId, typing);
    },

    async sendToolCall(callId: string, tool: string, args: object) {
      if (!client) return;
      client.sendToolCall(callId, tool, args);
    },
  });
}
