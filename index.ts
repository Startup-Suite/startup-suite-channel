import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { SuiteClient, type AttentionPayload } from "./src/suite-client.js";
import { formatContextPreamble } from "./src/message-bridge.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const raw = readFileSync(join(__dirname, "config.json"), "utf-8");
  return JSON.parse(raw);
}

const CHANNEL_ID = "startup-suite";
let activeClient: SuiteClient | null = null;

// Store the runtime reference for use in inbound handling
let pluginRuntime: any = null;
let pluginConfig: any = null;

async function handleInbound(payload: AttentionPayload) {
  if (!pluginRuntime || !pluginConfig || !activeClient) return;

  const core = pluginRuntime.channel;
  const rawBody = payload.message?.content?.trim() ?? "";
  if (!rawBody) return;

  const spaceId = payload.signal.space_id;
  const senderName = payload.message.author;

  // Build context preamble
  const enrichedContext = {
    ...payload.context,
    space: { ...(payload.context?.space || {}), id: spaceId },
  };
  const preamble = formatContextPreamble(enrichedContext);
  const enrichedBody = preamble
    ? `${preamble}---\n\n**${senderName}**: ${rawBody}`
    : `**${senderName}**: ${rawBody}`;

  // Resolve agent route
  const route = core.routing.resolveAgentRoute({
    cfg: pluginConfig,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: { kind: "group" as const, id: spaceId },
  });

  // Build envelope
  const storePath = core.session.resolveStorePath(pluginConfig.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(pluginConfig);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.reply.formatAgentEnvelope({
    channel: "Startup Suite",
    from: senderName,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: enrichedBody,
  });

  // Build finalized context
  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `startup-suite:${senderName}`,
    To: `startup-suite:${spaceId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: senderName,
    SenderName: senderName,
    SenderId: senderName,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: payload.signal?.message_id || String(Date.now()),
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `startup-suite:${spaceId}`,
    CommandAuthorized: true,
  });

  // Dispatch through the full agent pipeline
  const client = activeClient;
  await core.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg: pluginConfig,
    dispatcher: {
      sendFinalReply: async (replyPayload: any) => {
        const text = replyPayload?.text || "";
        if (text && client) {
          client.sendReply(spaceId, text);
        }
        return true;
      },
      sendToolResult: async () => true,
      getQueuedCounts: () => ({}),
    },
  });
}

const plugin = {
  id: "startup-suite-channel",
  name: "Startup Suite",
  description: "Federated agent runtime via Startup Suite",

  register(api: OpenClawPluginApi) {
    pluginRuntime = api.runtime;
    pluginConfig = api.config;

    // Register as a channel
    api.registerChannel({
      plugin: {
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
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true }),
          defaultAccountId: () => "default",
          isEnabled: () => true,
          isConfigured: () => {
            const cfg = loadConfig();
            return Boolean(cfg.url && cfg.runtimeId && cfg.token);
          },
          describeAccount: () => ({
            accountId: "default",
            enabled: true,
            configured: true,
          }),
        },
        outbound: {
          deliveryMode: "direct" as const,
          sendText: async ({ to, text }: { to: string; text: string }) => {
            if (activeClient) activeClient.sendReply(to, text);
            return { ok: true };
          },
        },
        gateway: {
          async startAccount(ctx: any) {
            pluginConfig = ctx.cfg;
            const suiteConfig = loadConfig();

            activeClient = new SuiteClient(suiteConfig, {
              async onAttention(payload) {
                try {
                  await handleInbound(payload);
                } catch (err: any) {
                  ctx.runtime?.error?.(`startup-suite: ${String(err)}`);
                  console.error("[suite] inbound error:", err);
                }
              },
              onToolResult(payload) {
                ctx.log?.info?.(`startup-suite: tool result ${payload.call_id}`);
              },
              onDisconnect() {
                ctx.log?.warn?.("startup-suite: connection lost, reconnecting...");
              },
            });

            activeClient.connect();
            ctx.log?.info?.(`startup-suite: connected as runtime ${suiteConfig.runtimeId}`);

            // Stay alive until abort
            await new Promise<void>((resolve) => {
              if (ctx.abortSignal?.aborted) { resolve(); return; }
              ctx.abortSignal?.addEventListener("abort", () => {
                activeClient?.disconnect();
                activeClient = null;
                resolve();
              }, { once: true });
            });
          },
        },
      },
    });

    // Forward LLM usage from Suite sessions to the analytics dashboard
    api.on("llm_output", (event, ctx) => {
      if (ctx.channelId !== "startup-suite") return;
      if (!activeClient) return;
      const u = event.usage || {};
      // Extract space_id from session key (format: agent:main:startup-suite:group:<space_id>)
      const parts = (ctx.sessionKey || "").split(":");
      const spaceId = parts.length >= 5 ? parts[4] : parts.length >= 4 ? parts[3] : undefined;

      activeClient.sendUsageEvent({
        space_id: spaceId,
        session_key: ctx.sessionKey,
        model: event.model,
        provider: event.provider,
        input_tokens: u.input || 0,
        output_tokens: u.output || 0,
        cache_read_tokens: u.cacheRead || 0,
        cache_write_tokens: u.cacheWrite || 0,
        cost_usd: 0,
        latency_ms: 0,
        metadata: {
          session_id: event.sessionId || ctx.sessionId,
          run_id: event.runId,
        },
      });
    });

    // Register Suite tools
    api.registerTool({
      name: "suite_canvas_create",
      description: "Create a live collaborative canvas in a Startup Suite space.",
      parameters: {
        type: "object" as const,
        properties: {
          space_id: { type: "string", description: "UUID of the Suite space" },
          canvas_type: { type: "string", description: "Canvas type: table, dashboard, code, diagram, custom" },
          title: { type: "string", description: "Canvas title" },
        },
        required: ["space_id", "canvas_type", "title"],
      },
      execute: async (toolCallId: string, args: any) => {
        if (!activeClient) return { content: "Suite not connected" };
        try {
          const result = await activeClient.callTool("canvas_create", args);
          return { content: JSON.stringify(result) };
        } catch (err: any) {
          return { content: `Error: ${err.message}` };
        }
      },
    } as any);

    // Send a message with media attachments (images, files) into a Suite space
    api.registerTool({
      name: "suite_send_media",
      description: "Send a message with file attachments (images, documents) into a Startup Suite space. Use for sharing diagrams, screenshots, or generated files.",
      parameters: {
        type: "object" as const,
        properties: {
          space_id: { type: "string", description: "UUID of the Suite space" },
          content: { type: "string", description: "Message text (markdown supported)" },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description: "Local file paths to attach",
          },
        },
        required: ["space_id", "file_paths"],
      },
      execute: async (toolCallId: string, args: any) => {
        if (!activeClient) return { content: "Suite not connected" };
        const { space_id, content = "", file_paths = [] } = args;

        try {
          const attachments = await Promise.all(
            (file_paths as string[]).map(async (filePath: string) => {
              const data = await readFile(filePath);
              const filename = filePath.split("/").pop() || "attachment";
              // Basic MIME type from extension
              const ext = filename.split(".").pop()?.toLowerCase() || "";
              const mimeMap: Record<string, string> = {
                png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
                txt: "text/plain", md: "text/markdown", json: "application/json",
                svg: "image/svg+xml",
              };
              const contentType = mimeMap[ext] || "application/octet-stream";
              return { filename, contentType, data: data.toString("base64") };
            })
          );

          activeClient.sendReplyWithMedia(space_id, content, attachments);
          return { content: `Sent message with ${attachments.length} attachment(s) to space ${space_id}` };
        } catch (err: any) {
          return { content: `Error: ${err.message}` };
        }
      },
    } as any);

    // ── Task management tools ─────────────────────────────────────────────

    const suiteToolHelper = async (toolName: string, args: any) => {
      if (!activeClient) return { content: "Suite not connected" };
      try {
        const result = await activeClient.callTool(toolName, args);
        return { content: JSON.stringify(result, null, 2) };
      } catch (err: any) {
        return { content: `Error: ${err.message}` };
      }
    };

    api.registerTool({
      name: "suite_project_list",
      description: "List all projects in Startup Suite.",
      parameters: { type: "object" as const, properties: {} },
      execute: async (_id: string, args: any) => suiteToolHelper("project_list", args),
    } as any);

    api.registerTool({
      name: "suite_epic_list",
      description: "List epics in Startup Suite, optionally filtered by project.",
      parameters: {
        type: "object" as const,
        properties: {
          project_id: { type: "string", description: "Filter by project ID (optional)" },
        },
      },
      execute: async (_id: string, args: any) => suiteToolHelper("epic_list", args),
    } as any);

    api.registerTool({
      name: "suite_task_create",
      description: "Create a task in Startup Suite. Tasks appear on the kanban board at /tasks.",
      parameters: {
        type: "object" as const,
        properties: {
          project_id: { type: "string", description: "Project ID (required)" },
          title: { type: "string", description: "Task title (required)" },
          description: { type: "string", description: "Task description" },
          epic_id: { type: "string", description: "Epic ID to assign to" },
          status: { type: "string", description: "Initial status: backlog (default), planning, ready, in_progress, in_review, done, blocked" },
          priority: { type: "string", description: "Priority: low, medium (default), high, critical" },
        },
        required: ["project_id", "title"],
      },
      execute: async (_id: string, args: any) => suiteToolHelper("task_create", args),
    } as any);

    api.registerTool({
      name: "suite_task_get",
      description: "Get a task by ID from Startup Suite.",
      parameters: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
      execute: async (_id: string, args: any) => suiteToolHelper("task_get", args),
    } as any);

    api.registerTool({
      name: "suite_task_list",
      description: "List tasks in Startup Suite with optional filters.",
      parameters: {
        type: "object" as const,
        properties: {
          project_id: { type: "string", description: "Filter by project ID" },
          epic_id: { type: "string", description: "Filter by epic ID" },
          status: { type: "string", description: "Filter by status" },
        },
      },
      execute: async (_id: string, args: any) => suiteToolHelper("task_list", args),
    } as any);

    api.registerTool({
      name: "suite_task_update",
      description: "Update a task in Startup Suite (title, description, status, priority, epic, assignee).",
      parameters: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID (required)" },
          title: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          status: { type: "string", description: "New status" },
          priority: { type: "string", description: "New priority" },
          epic_id: { type: "string", description: "Move to different epic" },
        },
        required: ["task_id"],
      },
      execute: async (_id: string, args: any) => suiteToolHelper("task_update", args),
    } as any);
  },
};

export default plugin;
