import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { SuiteClient, type AttentionPayload, type SuiteConfig } from "./src/suite-client.js";
import { formatContextPreamble } from "./src/message-bridge.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig(): SuiteConfig {
  const raw = readFileSync(join(__dirname, "config.json"), "utf-8");
  return JSON.parse(raw);
}

const CHANNEL_ID = "startup-suite";

// ── Multi-account state ───────────────────────────────────────────────────

// One SuiteClient per accountId
const clients = new Map<string, SuiteClient>();

// space_id → accountId: populated on first inbound, used for outbound routing
const spaceToAccountId = new Map<string, string>();

let pluginRuntime: any = null;
let pluginConfig: any = null;

// ── Config resolution ─────────────────────────────────────────────────────

/**
 * Resolve SuiteConfig for a given account.
 * Checks channels.startup-suite.accounts[accountId] in openclaw config first,
 * then falls back to config.json for the "default" account (backward compat).
 */
function resolveAccountConfig(cfg: any, accountId: string): SuiteConfig | null {
  const account = cfg?.channels?.["startup-suite"]?.accounts?.[accountId];
  if (account?.url && account?.runtimeId && account?.token) {
    return {
      url: account.url,
      runtimeId: account.runtimeId,
      token: account.token,
      autoJoinSpaces: account.autoJoinSpaces ?? [],
      reconnectIntervalMs: account.reconnectIntervalMs ?? 5000,
      maxReconnectIntervalMs: account.maxReconnectIntervalMs ?? 60000,
    };
  }
  // Backward compat: "default" account reads from config.json
  if (accountId === "default") {
    try {
      return loadConfig();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get the best client for a given space.
 * Uses the space→account mapping if available, falls back to first client.
 */
function clientForSpace(spaceId: string): SuiteClient | null {
  const accountId = spaceToAccountId.get(spaceId);
  if (accountId) {
    const client = clients.get(accountId);
    if (client) return client;
  }
  const first = clients.values().next().value;
  return first ?? null;
}

/**
 * Get the best client for a tool call.
 * Uses space_id from args if present, otherwise falls back to first client.
 */
function clientForTool(args: any): SuiteClient | null {
  const spaceId = args?.space_id;
  if (spaceId) return clientForSpace(spaceId);
  const first = clients.values().next().value;
  return first ?? null;
}

// ── Inbound handling ──────────────────────────────────────────────────────

async function handleInbound(payload: AttentionPayload, accountId: string) {
  const client = clients.get(accountId);
  if (!client || !pluginRuntime || !pluginConfig) return;

  const core = pluginRuntime.channel;
  const rawBody = payload.message?.content?.trim() ?? "";
  if (!rawBody) return;

  const spaceId = payload.signal.space_id;
  const senderName = payload.message.author;

  // Track space → account for outbound routing
  spaceToAccountId.set(spaceId, accountId);

  // Build context preamble
  const enrichedContext = {
    ...payload.context,
    space: { ...(payload.context?.space || {}), id: spaceId },
  };
  const preamble = formatContextPreamble(enrichedContext);
  const enrichedBody = preamble
    ? `${preamble}---\n\n**${senderName}**: ${rawBody}`
    : `**${senderName}**: ${rawBody}`;

  // Resolve agent route per account
  const route = core.routing.resolveAgentRoute({
    cfg: pluginConfig,
    channel: CHANNEL_ID,
    accountId,
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

  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `startup-suite:${senderName}`,
    To: `startup-suite:${spaceId}`,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: "group",
    ConversationLabel: senderName,
    SenderName: senderName,
    SenderId: senderName,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: (payload.signal as any)?.message_id || String(Date.now()),
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `startup-suite:${spaceId}`,
    CommandAuthorized: true,
  });

  await core.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg: pluginConfig,
    dispatcher: {
      sendFinalReply: async (replyPayload: any) => {
        const text = replyPayload?.text || "";
        if (text) client.sendReply(spaceId, text);
        return true;
      },
      sendToolResult: async () => true,
      getQueuedCounts: () => ({}),
    },
  });
}

// ── Model pricing (per 1M tokens) ─────────────────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-6":   { input: 5.0, output: 25.0 },
  "claude-sonnet-4":   { input: 3.0, output: 15.0 },
  "claude-opus-4":     { input: 5.0, output: 25.0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(MODEL_PRICING).find((k) => model.includes(k)) || "";
  const pricing = MODEL_PRICING[key];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// ── Plugin registration ───────────────────────────────────────────────────

const plugin = {
  id: "startup-suite-channel",
  name: "Startup Suite",
  description: "Federated agent runtime via Startup Suite",

  register(api: OpenClawPluginApi) {
    pluginRuntime = api.runtime;
    pluginConfig = api.config;

    // ── Channel registration ────────────────────────────────────────────

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
          listAccountIds: (cfg: any) => {
            const accounts = cfg?.channels?.["startup-suite"]?.accounts;
            if (accounts && Object.keys(accounts).length > 0) {
              return Object.keys(accounts);
            }
            // Backward compat: single default account from config.json
            try {
              loadConfig();
              return ["default"];
            } catch {
              return [];
            }
          },
          resolveAccount: (cfg: any, accountId?: string) => {
            const id = accountId ?? "default";
            const suiteConfig = resolveAccountConfig(cfg, id);
            return {
              accountId: id,
              enabled: Boolean(suiteConfig),
              configured: Boolean(suiteConfig?.runtimeId && suiteConfig?.token),
            };
          },
          defaultAccountId: () => "default",
          isEnabled: () => true,
          isConfigured: () => {
            const cfg = pluginConfig;
            const accounts = cfg?.channels?.["startup-suite"]?.accounts;
            if (accounts && Object.keys(accounts).length > 0) return true;
            try { loadConfig(); return true; } catch { return false; }
          },
          describeAccount: (cfg: any, accountId?: string) => {
            const id = accountId ?? "default";
            return {
              accountId: id,
              enabled: true,
              configured: Boolean(resolveAccountConfig(cfg, id)),
            };
          },
        },
        outbound: {
          deliveryMode: "direct" as const,
          sendText: async ({ to, text }: { to: string; text: string }) => {
            const spaceId = to.startsWith(`${CHANNEL_ID}:`)
              ? to.slice(`${CHANNEL_ID}:`.length)
              : to;
            const client = clientForSpace(spaceId);
            if (client) client.sendReply(spaceId, text);
            return { ok: Boolean(client) };
          },
        },
        gateway: {
          async startAccount(ctx: any) {
            pluginConfig = ctx.cfg;
            const accountId: string = ctx.accountId ?? "default";
            const suiteConfig = resolveAccountConfig(ctx.cfg, accountId);

            if (!suiteConfig) {
              ctx.log?.error?.(
                `startup-suite: no config found for account "${accountId}". ` +
                `Set channels.startup-suite.accounts.${accountId} in openclaw config, ` +
                `or provide config.json for the "default" account.`
              );
              return;
            }

            const client = new SuiteClient(suiteConfig, {
              async onAttention(payload) {
                try {
                  await handleInbound(payload, accountId);
                } catch (err: any) {
                  ctx.runtime?.error?.(`startup-suite[${accountId}]: ${String(err)}`);
                  console.error(`[suite] inbound error (account: ${accountId}):`, err);
                }
              },
              onToolResult(payload) {
                ctx.log?.info?.(`startup-suite[${accountId}]: tool result ${payload.call_id}`);
              },
              onDisconnect() {
                ctx.log?.warn?.(
                  `startup-suite[${accountId}]: connection lost, reconnecting...`
                );
              },
            });

            clients.set(accountId, client);
            client.connect();
            ctx.log?.info?.(
              `startup-suite: account "${accountId}" connected as runtime ${suiteConfig.runtimeId}`
            );

            // Stay alive until abort
            await new Promise<void>((resolve) => {
              if (ctx.abortSignal?.aborted) {
                resolve();
                return;
              }
              ctx.abortSignal?.addEventListener(
                "abort",
                () => {
                  client.disconnect();
                  clients.delete(accountId);
                  // Clean up space mappings for this account
                  for (const [spaceId, acctId] of spaceToAccountId.entries()) {
                    if (acctId === accountId) spaceToAccountId.delete(spaceId);
                  }
                  resolve();
                },
                { once: true }
              );
            });
          },
        },
      },
    });

    // ── LLM usage forwarding ────────────────────────────────────────────

    api.on("llm_output", (event, ctx) => {
      if (
        !ctx.channelId?.includes("startup-suite") &&
        !ctx.sessionKey?.includes("startup-suite")
      )
        return;

      // Resolve client via space_id parsed from session key
      // Session key format: agent:<agentId>:startup-suite:<chatType>:<spaceId>
      const parts = (ctx.sessionKey || "").split(":");
      const spaceId =
        parts.length >= 5 ? parts[4] : parts.length >= 4 ? parts[3] : undefined;

      let client: SuiteClient | null = null;
      if (spaceId) client = clientForSpace(spaceId);
      if (!client) client = clients.values().next().value ?? null;
      if (!client) return;

      const u = event.usage || {};
      const inputTokens = u.input || 0;
      const outputTokens = u.output || 0;
      const costUsd = estimateCost(event.model || "", inputTokens, outputTokens);

      client.sendUsageEvent({
        space_id: spaceId,
        session_key: ctx.sessionKey,
        model: event.model,
        provider: event.provider,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: u.cacheRead || 0,
        cache_write_tokens: u.cacheWrite || 0,
        cost_usd: costUsd,
        latency_ms: 0,
        metadata: {
          session_id: event.sessionId || ctx.sessionId,
          run_id: event.runId,
        },
      });
    });

    // ── Suite tool helper ───────────────────────────────────────────────

    const suiteToolHelper = async (toolName: string, args: any) => {
      const client = clientForTool(args);
      if (!client) return { content: "Suite not connected" };
      try {
        const result = await client.callTool(toolName, args);
        return { content: JSON.stringify(result, null, 2) };
      } catch (err: any) {
        return { content: `Error: ${err.message}` };
      }
    };

    // ── Canvas tools ────────────────────────────────────────────────────

    api.registerTool({
      name: "suite_canvas_create",
      description:
        "Create a live collaborative canvas in a Startup Suite space.",
      parameters: {
        type: "object" as const,
        properties: {
          space_id: { type: "string", description: "UUID of the Suite space" },
          canvas_type: {
            type: "string",
            description: "Canvas type: table, dashboard, code, diagram, custom",
          },
          title: { type: "string", description: "Canvas title" },
        },
        required: ["space_id", "canvas_type", "title"],
      },
      execute: async (_id: string, args: any) =>
        suiteToolHelper("canvas_create", args),
    } as any);

    api.registerTool({
      name: "suite_send_media",
      description:
        "Send a message with file attachments (images, documents) into a Startup Suite space. Use for sharing diagrams, screenshots, or generated files.",
      parameters: {
        type: "object" as const,
        properties: {
          space_id: { type: "string", description: "UUID of the Suite space" },
          content: {
            type: "string",
            description: "Message text (markdown supported)",
          },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description: "Local file paths to attach",
          },
        },
        required: ["space_id", "file_paths"],
      },
      execute: async (_id: string, args: any) => {
        const { space_id, content = "", file_paths = [] } = args;
        const client = clientForSpace(space_id);
        if (!client) return { content: "Suite not connected" };

        try {
          const attachments = await Promise.all(
            (file_paths as string[]).map(async (filePath: string) => {
              const data = await readFile(filePath);
              const filename = filePath.split("/").pop() || "attachment";
              const ext = filename.split(".").pop()?.toLowerCase() || "";
              const mimeMap: Record<string, string> = {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
                pdf: "application/pdf",
                txt: "text/plain",
                md: "text/markdown",
                json: "application/json",
                svg: "image/svg+xml",
              };
              const contentType = mimeMap[ext] || "application/octet-stream";
              return { filename, contentType, data: data.toString("base64") };
            })
          );

          client.sendReplyWithMedia(space_id, content, attachments);
          return {
            content: `Sent message with ${attachments.length} attachment(s) to space ${space_id}`,
          };
        } catch (err: any) {
          return { content: `Error: ${err.message}` };
        }
      },
    } as any);

    // ── Task management tools ───────────────────────────────────────────

    api.registerTool({
      name: "suite_project_list",
      description: "List all projects in Startup Suite.",
      parameters: { type: "object" as const, properties: {} },
      execute: async (_id: string, args: any) =>
        suiteToolHelper("project_list", args),
    } as any);

    api.registerTool({
      name: "suite_epic_list",
      description:
        "List epics in Startup Suite, optionally filtered by project.",
      parameters: {
        type: "object" as const,
        properties: {
          project_id: {
            type: "string",
            description: "Filter by project ID (optional)",
          },
        },
      },
      execute: async (_id: string, args: any) =>
        suiteToolHelper("epic_list", args),
    } as any);

    api.registerTool({
      name: "suite_task_create",
      description:
        "Create a task in Startup Suite. Tasks appear on the kanban board at /tasks.",
      parameters: {
        type: "object" as const,
        properties: {
          project_id: { type: "string", description: "Project ID (required)" },
          title: { type: "string", description: "Task title (required)" },
          description: { type: "string", description: "Task description" },
          epic_id: { type: "string", description: "Epic ID to assign to" },
          status: {
            type: "string",
            description:
              "Initial status: backlog (default), planning, ready, in_progress, in_review, done, blocked",
          },
          priority: {
            type: "string",
            description: "Priority: low, medium (default), high, critical",
          },
        },
        required: ["project_id", "title"],
      },
      execute: async (_id: string, args: any) =>
        suiteToolHelper("task_create", args),
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
      execute: async (_id: string, args: any) =>
        suiteToolHelper("task_get", args),
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
      execute: async (_id: string, args: any) =>
        suiteToolHelper("task_list", args),
    } as any);

    api.registerTool({
      name: "suite_task_update",
      description:
        "Update a task in Startup Suite (title, description, status, priority, epic, assignee).",
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
      execute: async (_id: string, args: any) =>
        suiteToolHelper("task_update", args),
    } as any);
  },
};

export default plugin;
