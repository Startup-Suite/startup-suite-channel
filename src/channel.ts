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
  return async (toolCallId: string, params: Record<string, unknown>) => {
    const c = activeClient;
    if (!c) throw new Error("Suite client is not connected");

    // Debug: log the raw args to catch serialization mismatches
    if (!params || typeof params !== "object" || typeof params === "string") {
      console.error(`[suite-tool] ${toolName}: invalid params type=${typeof params}, toolCallId=${toolCallId}, raw=`, params);
      throw new Error(`Invalid args for ${toolName}: expected object, got ${typeof params} (${JSON.stringify(params).slice(0, 200)})`);
    }

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
    {
      name: "suite_send_media",
      label: "Send Media to Suite Space",
      description:
        "Send a message with file attachments (images, documents) into a Startup Suite space.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        file_paths: Type.Array(Type.String(), { description: "Local file paths to attach" }),
        content: Type.Optional(Type.String({ description: "Message text (markdown supported)" })),
      }),
      execute: suiteToolExecute("send_media"),
    },
    {
      name: "suite_project_list",
      label: "List Suite Projects",
      description: "List all projects in Startup Suite.",
      parameters: Type.Object({}),
      execute: suiteToolExecute("project_list"),
    },
    {
      name: "suite_epic_list",
      label: "List Suite Epics",
      description: "List epics in Startup Suite, optionally filtered by project.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Filter by project ID" })),
      }),
      execute: suiteToolExecute("epic_list"),
    },
    {
      name: "suite_task_get",
      label: "Get Suite Task",
      description: "Get a task by ID from Startup Suite.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID" }),
      }),
      execute: suiteToolExecute("task_get"),
    },
    {
      name: "suite_task_list",
      label: "List Suite Tasks",
      description: "List tasks in Startup Suite with optional filters.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Filter by project ID" })),
        epic_id: Type.Optional(Type.String({ description: "Filter by epic ID" })),
        status: Type.Optional(Type.String({ description: "Filter by status" })),
      }),
      execute: suiteToolExecute("task_list"),
    },
    {
      name: "suite_task_update",
      label: "Update Suite Task",
      description: "Update a task in Startup Suite (title, description, status, priority, epic, assignee).",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID" }),
        title: Type.Optional(Type.String({ description: "New title" })),
        description: Type.Optional(Type.String({ description: "New description" })),
        status: Type.Optional(Type.String({ description: "New status" })),
        priority: Type.Optional(Type.String({ description: "New priority" })),
        epic_id: Type.Optional(Type.String({ description: "Move to different epic" })),
      }),
      execute: suiteToolExecute("task_update"),
    },
    {
      name: "suite_plan_create",
      label: "Create Suite Plan",
      description: "Create a plan (ordered stages) for a task. Plans must be approved before execution.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID to create the plan for" }),
        stages: Type.Array(
          Type.Object({
            name: Type.String({ description: "Stage name" }),
            description: Type.Optional(Type.String({ description: "What this stage does" })),
            position: Type.Number({ description: "Order position (1-based)" }),
            validations: Type.Optional(
              Type.Array(Type.Object({ kind: Type.String() }))
            ),
          }),
          { description: "Ordered list of stages" }
        ),
      }),
      execute: suiteToolExecute("plan_create"),
    },
    {
      name: "suite_plan_get",
      label: "Get Suite Plan",
      description: "Get the current approved plan for a task, including all stages and their validation status.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID" }),
      }),
      execute: suiteToolExecute("plan_get"),
    },
    {
      name: "suite_plan_submit",
      label: "Submit Suite Plan",
      description: "Submit a draft plan for human review. Plan must be in 'draft' status.",
      parameters: Type.Object({
        plan_id: Type.String({ description: "Plan ID to submit" }),
      }),
      execute: suiteToolExecute("plan_submit"),
    },
    {
      name: "suite_stage_start",
      label: "Start Suite Stage",
      description: "Start a stage, transitioning it from pending to running. The plan must be approved.",
      parameters: Type.Object({
        stage_id: Type.String({ description: "Stage ID to start" }),
      }),
      execute: suiteToolExecute("stage_start"),
    },
    {
      name: "suite_stage_list",
      label: "List Suite Stages",
      description: "List all stages for a plan, ordered by position.",
      parameters: Type.Object({
        plan_id: Type.String({ description: "Plan ID" }),
      }),
      execute: suiteToolExecute("stage_list"),
    },
    {
      name: "suite_validation_evaluate",
      label: "Evaluate Suite Validation",
      description: "Submit a pass or fail result for a validation check.",
      parameters: Type.Object({
        validation_id: Type.String({ description: "Validation ID" }),
        status: Type.String({ description: "'passed' or 'failed'" }),
        evaluated_by: Type.Optional(Type.String({ description: "Who evaluated this" })),
        evidence: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Supporting evidence" })),
      }),
      execute: suiteToolExecute("validation_evaluate"),
    },
    {
      name: "suite_validation_list",
      label: "List Suite Validations",
      description: "List all validations for a stage.",
      parameters: Type.Object({
        stage_id: Type.String({ description: "Stage ID" }),
      }),
      execute: suiteToolExecute("validation_list"),
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
