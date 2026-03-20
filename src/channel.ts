import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { Type } from "@sinclair/typebox";
import { SuiteClient } from "./suite-client.js";
import { handleSuiteInbound } from "./inbound.js";
import type { OpenClawConfig } from "./runtime-api.js";

const CHANNEL_ID = "startup-suite";

let activeClient: SuiteClient | null = null;

export function getActiveClient(): SuiteClient | null {
  return activeClient;
}

// ── Suite tool helpers ──────────────────────────────────────────────

function suiteToolExecute(toolName: string) {
  return async (_toolCallId: string, params: Record<string, unknown>) => {
    const c = activeClient;
    if (!c) throw new Error("Suite client is not connected");
    const result = await c.callTool(toolName, params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
  };
}

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
    listAccountIds: () => ["default"],
    resolveAccount: (_cfg, _accountId) => ({ accountId: "default", enabled: true }),
    defaultAccountId: () => "default",
    isConfigured: () => true,
    describeAccount: () => ({
      accountId: "default",
      enabled: true,
      configured: true,
    }),
  },

  agentTools: [
    {
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
      execute: suiteToolExecute("canvas_create"),
    },
    {
      name: "suite_canvas_update",
      label: "Update Suite Canvas",
      description:
        "Update an existing canvas in a Startup Suite space. Use to modify the content, title, or state of a canvas that was previously created.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        canvas_id: Type.String({ description: "UUID of the canvas to update" }),
        updates: Type.Record(Type.String(), Type.Unknown(), { description: "Fields to update on the canvas (e.g. title, state)" }),
      }),
      execute: suiteToolExecute("canvas_update"),
    },
    {
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
      execute: suiteToolExecute("task_create"),
    },
    {
      name: "suite_task_complete",
      label: "Complete Suite Task",
      description:
        "Mark an existing task as done in a Startup Suite space.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        task_id: Type.String({ description: "UUID of the task to mark complete" }),
      }),
      execute: suiteToolExecute("task_complete"),
    },
  ],

  outbound: {
    deliveryMode: "direct",
    async sendText({ to, text }) {
      const client = activeClient;
      if (!client) throw new Error("Suite client is not connected");
      if (!to) throw new Error("Missing Startup Suite space id");
      client.sendReply(to, text);
      return { ok: true, channel: CHANNEL_ID };
    },
  },

  gateway: {
    async startAccount(ctx) {
      const { cfg, runtime } = ctx;
      // Load Suite-specific config from config.json
      const { readFileSync } = await import("node:fs");
      const { dirname, join } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const raw = readFileSync(join(__dirname, "..", "config.json"), "utf-8");
      const suiteConfig = JSON.parse(raw);

      activeClient = new SuiteClient(suiteConfig, {
        async onAttention(payload) {
          try {
            await handleSuiteInbound({
              payload,
              config: cfg as OpenClawConfig,
              runtime,
              client: activeClient!,
            });
          } catch (err: any) {
            runtime.error?.(`startup-suite: attention handler error: ${String(err)}`);
          }
        },

        onToolResult(payload) {
          runtime.info?.(`startup-suite: tool result: ${payload.call_id}`);
        },

        onDisconnect() {
          runtime.warn?.(`startup-suite: connection lost, reconnecting...`);
        },
      });

      activeClient.connect();
      runtime.info?.(`startup-suite: connected as runtime ${suiteConfig.runtimeId}`);

      // Keep the account alive until abort signal fires
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => {
          if (activeClient) {
            activeClient.disconnect();
            activeClient = null;
          }
          resolve();
        }, { once: true });
      });
    },
  },
};
