import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { onDiagnosticEvent, type DiagnosticUsageEvent } from "openclaw/plugin-sdk/diagnostics-otel";
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

            // Forward usage diagnostics from Suite sessions to the analytics API
            const unsubDiag = onDiagnosticEvent((evt) => {
              if (evt.type !== "model.usage") return;
              const usageEvt = evt as DiagnosticUsageEvent;
              // Only forward events from startup-suite channel sessions
              if (usageEvt.channel !== "startup-suite") return;
              // Use lastCallUsage (per-request) if available, else cumulative
              const u = usageEvt.lastCallUsage || usageEvt.usage || {};
              // Extract space_id from session key (format: startup-suite:default:group:<space_id>)
              const parts = (usageEvt.sessionKey || "").split(":");
              const spaceId = parts.length >= 4 ? parts[3] : undefined;

              activeClient?.sendUsageEvent({
                space_id: spaceId,
                session_key: usageEvt.sessionKey,
                model: usageEvt.model,
                provider: usageEvt.provider,
                input_tokens: u.input || 0,
                output_tokens: u.output || 0,
                cache_read_tokens: u.cacheRead || 0,
                cache_write_tokens: u.cacheWrite || 0,
                cost_usd: usageEvt.costUsd || 0,
                latency_ms: usageEvt.durationMs || 0,
                metadata: {
                  session_id: usageEvt.sessionId,
                  context_limit: usageEvt.context?.limit,
                  context_used: usageEvt.context?.used,
                },
              });
            });

            // Stay alive until abort
            await new Promise<void>((resolve) => {
              if (ctx.abortSignal?.aborted) { resolve(); return; }
              ctx.abortSignal?.addEventListener("abort", () => {
                unsubDiag();
                activeClient?.disconnect();
                activeClient = null;
                resolve();
              }, { once: true });
            });
          },
        },
      },
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
  },
};

export default plugin;
