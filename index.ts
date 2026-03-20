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

const CHANNEL_ID = "suite";
const DEFAULT_ACCOUNT_ID = "default";

export default function register(api: OpenClawPluginApi) {
  let client: SuiteClient | null = null;
  let serviceLogger = api.logger;

  api.registerService({
    id: "suite-connection",
    name: "Suite WebSocket Connection",

    async start(ctx) {
      serviceLogger = ctx.logger;
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
          serviceLogger.warn("Suite connection lost, reconnecting...");
        },
      });

      client.connect();
      serviceLogger.info(`Connected to Suite as runtime ${config.runtimeId}`);
    },

    async stop() {
      if (client) {
        client.disconnect();
        client = null;
      }
    },
  });

  api.registerChannel({
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Startup Suite",
      selectionLabel: "Startup Suite",
      detailLabel: "Startup Suite Runtime",
      docsPath: "/plugins/startup-suite-channel",
      blurb: "Federated Startup Suite runtime over WebSocket.",
      order: 900,
    },
    capabilities: {
      chatTypes: ["direct", "group", "channel"],
      reply: true,
      threads: false,
      media: false,
    },
    config: {
      listAccountIds() {
        return [DEFAULT_ACCOUNT_ID];
      },
      resolveAccount() {
        return loadConfig();
      },
      defaultAccountId() {
        return DEFAULT_ACCOUNT_ID;
      },
      isEnabled() {
        return true;
      },
      isConfigured(account) {
        return Boolean(account.url && account.runtimeId && account.token);
      },
      describeAccount(account) {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          name: account.runtimeId || "Startup Suite",
          enabled: true,
          configured: Boolean(account.url && account.runtimeId && account.token),
          connected: client !== null,
          baseUrl: account.url,
        };
      },
    },

    async sendReply(sessionKey: string, content: string) {
      if (!client) return;
      const spaceId = sessionKey.replace(new RegExp(`^${CHANNEL_ID}:`), "");
      client.sendReply(spaceId, content);
    },

    async sendTyping(sessionKey: string, typing: boolean) {
      if (!client) return;
      const spaceId = sessionKey.replace(new RegExp(`^${CHANNEL_ID}:`), "");
      client.sendTyping(spaceId, typing);
    },

    async sendToolCall(callId: string, tool: string, args: object) {
      if (!client) return;
      client.sendToolCall(callId, tool, args);
    },
  });
}
