import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { SuiteClient } from "./suite-client.js";
import { handleSuiteInbound } from "./inbound.js";
import {
  clearClient,
  clientForSpace,
  listConfiguredAccountIds,
  rememberSpaceAccount,
  resolveAccountConfig,
  setClient,
} from "./plugin-state.js";

const CHANNEL_ID = "startup-suite";

export const suitePlugin: ChannelPlugin = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "Startup Suite",
    selectionLabel: "Startup Suite",
    docsPath: "/plugins/developing-plugins",
    blurb: "Federated agent runtime via Startup Suite",
  },

  capabilities: {
    chatTypes: ["direct", "group", "channel"],
    reply: true,
  },

  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

  config: {
    listAccountIds: (cfg) => listConfiguredAccountIds(cfg),
    resolveAccount: (cfg, accountId) => {
      const id = String(accountId ?? "default");
      const suiteConfig = resolveAccountConfig(cfg, id);
      return {
        accountId: id,
        enabled: Boolean(suiteConfig),
        configured: Boolean(suiteConfig?.url && suiteConfig?.runtimeId && suiteConfig?.token),
        ...suiteConfig,
      };
    },
    defaultAccountId: () => "default",
    isEnabled: (account) => Boolean(account?.enabled ?? true),
    isConfigured: (account) => Boolean(account?.url && account?.runtimeId && account?.token),
    describeAccount: (account) => ({
      accountId: String(account?.accountId ?? "default"),
      enabled: Boolean(account?.enabled ?? true),
      configured: Boolean(account?.url && account?.runtimeId && account?.token),
    }),
  },


  outbound: {
    deliveryMode: "direct",
    async sendText({ to, text }) {
      if (!to) throw new Error("Missing Startup Suite space id");
      const spaceId = to.startsWith(`${CHANNEL_ID}:`) ? to.slice(`${CHANNEL_ID}:`.length) : to;
      const client = clientForSpace(spaceId);
      if (!client) throw new Error("Suite client is not connected");
      client.sendReply(spaceId, text);
      return { channel: CHANNEL_ID, messageId: `startup-suite:${Date.now()}` };
    },
  },

  gateway: {
    async startAccount(ctx) {
      const { cfg, log } = ctx;
      const accountId = ctx.accountId ?? "default";
      const runtime = {
        log: (message: string) => log?.info?.(message),
        error: (message: string) => log?.error?.(message),
      };

      runtime.log(`startup-suite(${accountId}): startAccount invoked`);
      const suiteConfig = resolveAccountConfig(cfg, accountId);

      if (!suiteConfig) {
        runtime.error(`startup-suite(${accountId}): missing configuration`);
        throw new Error(`startup-suite: missing configuration for account ${accountId}`);
      }

      const client = new SuiteClient(suiteConfig, {
        async onAttention(payload) {
          try {
            const spaceId = payload.signal?.space_id || payload.signal?.task_id;
            if (spaceId) rememberSpaceAccount(spaceId, accountId);

            await handleSuiteInbound({
              payload,
              config: cfg,
              runtime: runtime as any,
              client,
              accountId,
            });
          } catch (err: any) {
            runtime.error(`startup-suite: attention handler error: ${String(err)}`);
          }
        },

        onDisconnect() {
          runtime.log(`startup-suite(${accountId}): connection lost, reconnecting...`);
        },
      });

      setClient(accountId, client);
      client.connect();
      runtime.log(`startup-suite(${accountId}): connected as runtime ${suiteConfig.runtimeId}`);

      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            client.disconnect();
            clearClient(accountId);
            resolve();
          },
          { once: true }
        );
      });
    },
  },
};
