import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { Type as RawType } from "@sinclair/typebox";
import { SuiteClient } from "./suite-client.js";
import { handleSuiteInbound } from "./inbound.js";
import {
  clearClient,
  clientForSpace,
  clientForTool,
  listConfiguredAccountIds,
  rememberSpaceAccount,
  resolveAccountConfig,
  setClient,
} from "./plugin-state.js";

const Type: any = RawType;
const CHANNEL_ID = "startup-suite";

// ── Suite tool helpers ──────────────────────────────────────────────

function suiteToolExecute(toolName: string) {
  return async (toolCallId: string, params: unknown) => {
    if (!params || typeof params !== "object" || typeof params === "string") {
      console.error(`[suite-tool] ${toolName}: invalid params type=${typeof params}, toolCallId=${toolCallId}, raw=`, params);
      throw new Error(`Invalid args for ${toolName}: expected object, got ${typeof params}`);
    }

    const typedParams = params as Record<string, unknown>;
    const c = clientForTool(typedParams);
    if (!c) throw new Error("Suite client is not connected");

    const result = await c.callTool(toolName, typedParams);
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

  // Channel-era tools are registered here, but suppressed at plugin load when
  // every configured startup-suite account has `useMcpTools: true` — i.e. the
  // operator has fully cut over to Suite's `/mcp` endpoint for tool execution
  // (ADR 0034). Mixed or legacy configs keep the channel tools so existing
  // installs don't silently lose functionality during migration.
  agentTools: ({ cfg }: { cfg?: any }) => {
    const accounts: Record<string, any> = cfg?.channels?.["startup-suite"]?.accounts ?? {};
    const accountIds = Object.keys(accounts);
    const allAccountsUseMcpTools =
      accountIds.length > 0 && accountIds.every((id) => accounts[id]?.useMcpTools === true);
    if (allAccountsUseMcpTools) return [];
    return [
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
        project_id: Type.String({ description: "The project to create the task in" }),
        title: Type.String({ description: "Title / summary of the task" }),
        description: Type.Optional(Type.String({ description: "Longer description or acceptance criteria" })),
        epic_id: Type.Optional(Type.String({ description: "Epic to assign the task to" })),
        status: Type.Optional(Type.String({ description: "Initial status: backlog (default), planning, ready, in_progress, in_review, deploying, done, blocked" })),
        priority: Type.Optional(Type.String({ description: "Priority: low, medium (default), high, critical" })),
        assignee_type: Type.Optional(Type.String({ description: "Assignee type: user or agent" })),
        assignee_id: Type.Optional(Type.String({ description: "ID of the user or agent to assign" })),
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
      description:
        "Update a task's metadata (title, description, priority, epic). Do NOT use this to change task status during normal lifecycle execution — lifecycle status transitions (in_progress → in_review → done) are driven automatically by the plan engine when validations resolve. Only use the status field for exceptional out-of-band corrections.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID" }),
        title: Type.Optional(Type.String({ description: "New title" })),
        description: Type.Optional(Type.String({ description: "New description" })),
        status: Type.Optional(
          Type.String({
            description:
              "New status — for exceptional corrections only. Normal lifecycle transitions are driven by the plan engine.",
          })
        ),
        priority: Type.Optional(Type.String({ description: "New priority" })),
        epic_id: Type.Optional(Type.String({ description: "Move to different epic" })),
        assignee_type: Type.Optional(Type.String({ description: "Assignee type: user or agent" })),
        assignee_id: Type.Optional(Type.String({ description: "ID of the user or agent to assign" })),
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
      name: "validation_pass",
      label: "Pass Validation",
      description:
        "Alias for Suite validation pass convenience. Use when prompts refer to validation_pass directly.",
      parameters: Type.Object({
        validation_id: Type.String({ description: "Validation ID" }),
        evidence: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Supporting evidence" })),
        evaluated_by: Type.Optional(Type.String({ description: "Who evaluated this" })),
      }),
      execute: suiteToolExecute("validation_pass"),
    },
    {
      name: "stage_complete",
      label: "Complete Stage",
      description:
        "Alias for Suite stage completion helper. Use when prompts refer to stage_complete directly.",
      parameters: Type.Object({
        stage_id: Type.String({ description: "Stage ID to complete" }),
      }),
      execute: suiteToolExecute("stage_complete"),
    },
    {
      name: "report_blocker",
      label: "Report Blocker",
      description:
        "Report a structured blocker to Suite when prompts refer to report_blocker directly.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task ID" }),
        stage_id: Type.String({ description: "Stage ID" }),
        description: Type.String({ description: "What is blocked and why" }),
        needs_human: Type.Optional(Type.Boolean({ description: "Whether a human needs to intervene" })),
      }),
      execute: suiteToolExecute("report_blocker"),
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
    {
      name: "suite_review_request_create",
      label: "Create Suite Review Request",
      description:
        "Submit evidence for a manual_approval validation gate. Creates a review request with labelled items for human review. Each item is independently approvable. Use this instead of suite_validation_evaluate for manual_approval validations.",
      parameters: Type.Object({
        validation_id: Type.String({ description: "The manual_approval validation ID to submit evidence for" }),
        items: Type.Array(
          Type.Object({
            label: Type.String({ description: "Human-readable label for this review item (e.g. 'Desktop view', 'Mobile nav')" }),
            canvas_id: Type.Optional(Type.String({ description: "Optional canvas ID reference" })),
            content: Type.Optional(Type.String({ description: "Optional markdown description or text evidence" })),
          }),
          { description: "Labelled items for human review. Each is independently approvable." }
        ),
      }),
      execute: suiteToolExecute("review_request_create"),
    },
    {
      name: "review_request_create",
      label: "Create Review Request",
      description:
        "Alias for suite_review_request_create. Use when Suite dispatch prompts refer to review_request_create directly.",
      parameters: Type.Object({
        validation_id: Type.String({ description: "The manual_approval validation ID to submit evidence for" }),
        items: Type.Array(
          Type.Object({
            label: Type.String({ description: "Human-readable label for this review item" }),
            canvas_id: Type.Optional(Type.String({ description: "Optional canvas ID reference" })),
            content: Type.Optional(Type.String({ description: "Optional markdown description or text evidence" })),
          })
        ),
      }),
      execute: suiteToolExecute("review_request_create"),
    },
    {
      name: "suite_space_list",
      label: "List Suite Spaces",
      description:
        "List Suite spaces the agent is a member of. Use to discover space IDs for proactive messaging.",
      parameters: Type.Object({
        kind: Type.Optional(Type.String({ description: "Filter by kind: channel or dm" })),
      }),
      execute: suiteToolExecute("space_list"),
    },
    {
      name: "suite_space_get_context",
      label: "Get Suite Space Context",
      description:
        "Get a bounded context snapshot for a Suite space, including recent messages, participants, canvases, and active tasks.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        message_limit: Type.Optional(
          Type.Number({ description: "Number of recent messages to include (default 10, max 20)" })
        ),
        include_canvases: Type.Optional(
          Type.Boolean({ description: "Whether to include active canvas summaries (default true)" })
        ),
      }),
      execute: suiteToolExecute("space_get_context"),
    },
    {
      name: "space_get_context",
      label: "Get Space Context",
      description:
        "Alias for suite_space_get_context. Use when prompts refer to space_get_context directly.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        message_limit: Type.Optional(
          Type.Number({ description: "Number of recent messages to include (default 10, max 20)" })
        ),
        include_canvases: Type.Optional(
          Type.Boolean({ description: "Whether to include active canvas summaries (default true)" })
        ),
      }),
      execute: suiteToolExecute("space_get_context"),
    },
    {
      name: "suite_space_search_messages",
      label: "Search Suite Space Messages",
      description:
        "Search messages in a Suite space with bounded results.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default 5, max 10)" })),
      }),
      execute: suiteToolExecute("space_search_messages"),
    },
    {
      name: "space_search_messages",
      label: "Search Space Messages",
      description:
        "Alias for suite_space_search_messages. Use when prompts refer to space_search_messages directly.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default 5, max 10)" })),
      }),
      execute: suiteToolExecute("space_search_messages"),
    },
    {
      name: "suite_space_get_messages",
      label: "Get Suite Space Messages",
      description:
        "Fetch a bounded message window for a Suite space.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        around_message_id: Type.Optional(Type.String({ description: "Fetch a window centered around this message ID" })),
        before_message_id: Type.Optional(Type.String({ description: "Fetch messages before this message ID" })),
        after_message_id: Type.Optional(Type.String({ description: "Fetch messages after this message ID" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of messages to return (default 10, max 20)" })),
      }),
      execute: suiteToolExecute("space_get_messages"),
    },
    {
      name: "space_get_messages",
      label: "Get Space Messages",
      description:
        "Alias for suite_space_get_messages. Use when prompts refer to space_get_messages directly.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        around_message_id: Type.Optional(Type.String({ description: "Fetch a window centered around this message ID" })),
        before_message_id: Type.Optional(Type.String({ description: "Fetch messages before this message ID" })),
        after_message_id: Type.Optional(Type.String({ description: "Fetch messages after this message ID" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of messages to return (default 10, max 20)" })),
      }),
      execute: suiteToolExecute("space_get_messages"),
    },
    {
      name: "suite_canvas_list",
      label: "List Suite Canvases",
      description:
        "List canvases in a Suite space with bounded summaries.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of canvases to return (default 10, max 20)" })),
      }),
      execute: suiteToolExecute("canvas_list"),
    },
    {
      name: "canvas_list",
      label: "List Canvases",
      description:
        "Alias for suite_canvas_list. Use when prompts refer to canvas_list directly.",
      parameters: Type.Object({
        space_id: Type.String({ description: "UUID of the Suite space" }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of canvases to return (default 10, max 20)" })),
      }),
      execute: suiteToolExecute("canvas_list"),
    },
    {
      name: "suite_canvas_get",
      label: "Get Suite Canvas",
      description:
        "Retrieve a canvas from Startup Suite by ID, either as a summary or as the full document state.",
      parameters: Type.Object({
        canvas_id: Type.String({ description: "UUID of the canvas" }),
        mode: Type.Optional(Type.String({ description: "Retrieval mode: summary or document (default summary)" })),
      }),
      execute: suiteToolExecute("canvas_get"),
    },
    {
      name: "canvas_get",
      label: "Get Canvas",
      description:
        "Alias for suite_canvas_get. Use when prompts refer to canvas_get directly.",
      parameters: Type.Object({
        canvas_id: Type.String({ description: "UUID of the canvas" }),
        mode: Type.Optional(Type.String({ description: "Retrieval mode: summary or document (default summary)" })),
      }),
      execute: suiteToolExecute("canvas_get"),
    },
    {
      name: "suite_prompt_template_list",
      label: "List Suite Prompt Templates",
      description:
        "List all prompt templates (dispatch and heartbeat prompts) stored in the Suite database. Returns slug, name, description, variables, updated_by, updated_at.",
      parameters: Type.Object({}),
      execute: suiteToolExecute("prompt_template_list"),
    },
    {
      name: "prompt_template_list",
      label: "List Prompt Templates",
      description:
        "Alias for suite_prompt_template_list. Use when Suite dispatch prompts refer to prompt_template_list directly.",
      parameters: Type.Object({}),
      execute: suiteToolExecute("prompt_template_list"),
    },
    {
      name: "suite_prompt_template_update",
      label: "Update Suite Prompt Template",
      description:
        "Update the content of a prompt template by slug. Use {{variable_name}} placeholders for dynamic interpolation. Sets updated_by to \"agent\". Use suite_prompt_template_list to see available slugs and their variables.",
      parameters: Type.Object({
        slug: Type.String({
          description: "Template slug (e.g. dispatch.planning, dispatch.in_progress, dispatch.in_review, dispatch.fallback, heartbeat)",
        }),
        content: Type.String({
          description: "New template content with {{variable_name}} placeholders for interpolation",
        }),
      }),
      execute: suiteToolExecute("prompt_template_update"),
    },
    {
      name: "prompt_template_update",
      label: "Update Prompt Template",
      description:
        "Alias for suite_prompt_template_update. Use when Suite dispatch prompts refer to prompt_template_update directly.",
      parameters: Type.Object({
        slug: Type.String({ description: "Template slug" }),
        content: Type.String({ description: "New template content" }),
      }),
      execute: suiteToolExecute("prompt_template_update"),
    },
    {
      name: "suite_federation_status",
      label: "Suite Federation Status",
      description:
        "Check the connection status of all registered agent runtimes in Startup Suite. Shows which runtimes are online, when they connected, and when they last sent a message. Use to diagnose connectivity issues.",
      parameters: Type.Object({}),
      execute: suiteToolExecute("federation_status"),
    },
    {
      name: "suite_org_context_read",
      label: "Read Org Context File",
      description:
        "Read an organizational context file by key (e.g. ORG_IDENTITY.md, ORG_MEMORY.md). Returns the file content, current version, and metadata.",
      parameters: Type.Object({
        file_key: Type.String({ description: "File key to read (e.g. 'ORG_IDENTITY.md')" }),
      }),
      execute: suiteToolExecute("org_context_read"),
    },
    {
      name: "suite_org_context_write",
      label: "Write Org Context File",
      description:
        "Write or update an organizational context file by key. Creates the file if it doesn't exist. Supports optimistic locking via expected_version to prevent conflicting writes.",
      parameters: Type.Object({
        file_key: Type.String({ description: "File key to write (e.g. 'ORG_IDENTITY.md')" }),
        content: Type.String({ description: "Full content to write to the file" }),
        updated_by: Type.Optional(Type.String({ description: "UUID of the user or agent making the update" })),
        expected_version: Type.Optional(Type.Number({ description: "Expected current version for optimistic locking — write fails if file was modified since this version" })),
      }),
      execute: suiteToolExecute("org_context_write"),
    },
    {
      name: "suite_org_context_list",
      label: "List Org Context Files",
      description:
        "List all available organizational context files with their keys, versions, and metadata. Use to discover what context files exist before reading or writing.",
      parameters: Type.Object({}),
      execute: suiteToolExecute("org_context_list"),
    },
    {
      name: "suite_org_memory_append",
      label: "Append Org Memory Entry",
      description:
        "Append a short-lived note about today's activity to org memory. Entries are append-only and timestamped, and surface in agent context as ORG_NOTES-YYYY-MM-DD for the last 2 days. For curated long-term knowledge — decisions, patterns, lessons — update ORG_MEMORY.md via suite_org_context_write instead.",
      parameters: Type.Object({
        content: Type.String({ description: "Memory content to append" }),
        date: Type.Optional(Type.String({ description: "ISO 8601 date (YYYY-MM-DD) for the entry (default: today)" })),
        authored_by: Type.Optional(Type.String({ description: "UUID of the user or agent authoring this entry" })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Additional metadata for the memory entry" })),
      }),
      execute: suiteToolExecute("org_memory_append"),
    },
    {
      name: "suite_org_memory_search",
      label: "Search Org Memory",
      description:
        "Search organizational memory entries with optional filters. Supports case-insensitive substring matching and date ranges. For long-term curated knowledge, read ORG_MEMORY.md via suite_org_context_read instead.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Case-insensitive substring search query" })),
        date_from: Type.Optional(Type.String({ description: "ISO 8601 date (YYYY-MM-DD) — include entries on or after this date" })),
        date_to: Type.Optional(Type.String({ description: "ISO 8601 date (YYYY-MM-DD) — include entries on or before this date" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 50)" })),
      }),
      execute: suiteToolExecute("org_memory_search"),
    },
    ];
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

        onToolResult(payload) {
          runtime.log(`startup-suite: tool result: ${payload.call_id}`);
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
