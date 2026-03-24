import {
  dispatchInboundReplyWithBase,
  type OpenClawConfig,
  type RuntimeEnv,
} from "./runtime-api.js";
import { getSuiteRuntime } from "./runtime.js";
import { formatContextPreamble } from "./message-bridge.js";
import type { AttentionPayload } from "./suite-client.js";
import type { SuiteClient } from "./suite-client.js";

const CHANNEL_ID = "startup-suite";

export async function handleSuiteInbound(params: {
  payload: AttentionPayload;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  client: SuiteClient;
}): Promise<void> {
  const { payload, config, runtime, client } = params;
  const core = getSuiteRuntime();

  const rawBody = payload.message?.content?.trim() ?? "";
  if (!rawBody) {
    runtime.warn?.(`[suite-inbound] empty message body, signal=${payload.signal?.reason} task=${payload.signal?.task_id}`);
    return;
  }

  // Classify the signal
  const taskId = payload.signal?.task_id;
  const taskStatus = payload.signal?.task_status;
  const signalReason = payload.signal?.reason;
  const isOrchestrated = !!(
    taskId &&
    signalReason &&
    (signalReason === "task_assigned" || signalReason === "task_heartbeat")
  );

  // For orchestrated signals, the signal.space_id is the execution space which
  // isn't in the agent's routing config. Use the execution space for replies but
  // route via a synthetic peer so the default agent binding resolves correctly.
  const spaceId = payload.signal.space_id || payload.signal.task_id || "unknown";
  const senderId = payload.message.author || (isOrchestrated ? "TaskRouter" : "unknown");
  const senderName = payload.message.author || (isOrchestrated ? "TaskRouter" : "unknown");
  const isGroup = true;

  runtime.info?.(
    `[suite-inbound] reason=${signalReason || "chat"} task=${taskId || "none"} ` +
    `space=${spaceId} orchestrated=${isOrchestrated}`
  );

  // Build the enriched body with Suite context preamble
  const enrichedContext = {
    ...payload.context,
    space: { ...(payload.context?.space || { id: spaceId, name: spaceId }), id: spaceId },
  };
  const preamble = formatContextPreamble(enrichedContext);
  const enrichedBody = preamble
    ? `${preamble}---\n\n**${senderName}**: ${rawBody}`
    : `**${senderName}**: ${rawBody}`;

  function resolveTaskPhase(reason: string, status?: string): string {
    if (reason === "task_assigned" && status === "planning") return "planning";
    if (status === "in_progress") return "execution";
    if (status === "in_review") return "review";
    return "execution";
  }

  // Resolve agent route.
  // For orchestrated signals, use "orchestration" as the peer ID so the route
  // resolver falls through to the default agent binding. Execution space IDs
  // aren't in the routing config and would cause a mismatch.
  const routePeerId = isOrchestrated ? "orchestration" : spaceId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: "group",
      id: routePeerId,
    },
  });

  // Override session key for orchestrated task signals — isolates context per task per phase
  if (isOrchestrated && taskId) {
    const phase = resolveTaskPhase(signalReason!, taskStatus);
    route.sessionKey = `startup-suite:task:${taskId}:${phase}`;
  }

  runtime.info?.(
    `[suite-inbound] resolved route: agent=${route.agentId} session=${route.sessionKey}`
  );

  // Build envelope
  const fromLabel = senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Startup Suite",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: enrichedBody,
  });

  // Build finalized context
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `startup-suite:${senderId}`,
    To: `startup-suite:${spaceId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: payload.signal?.message_id || String(Date.now()),
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `startup-suite:${spaceId}`,
    CommandAuthorized: true,
  });

  // Dispatch through the full agent pipeline with token-level streaming
  const chunkId = `chunk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let lastChunkText = "";
  let lastChunkSentAt = 0;
  const CHUNK_THROTTLE_MS = 150;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;

  const flushChunk = (text: string, done: boolean) => {
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    if (text && client) {
      client.sendReplyChunk(spaceId, chunkId, text, done);
      lastChunkSentAt = Date.now();
      lastChunkText = text;
    }
  };

  const scheduleFlush = (text: string) => {
    const elapsed = Date.now() - lastChunkSentAt;
    if (elapsed >= CHUNK_THROTTLE_MS) {
      flushChunk(text, false);
    } else if (!pendingFlush) {
      pendingFlush = setTimeout(() => {
        pendingFlush = null;
        flushChunk(text, false);
      }, CHUNK_THROTTLE_MS - elapsed);
    }
  };

  // For orchestrated signals, don't show typing in the execution space
  // (it's machine-to-machine, no human watching)
  if (!isOrchestrated) {
    client.sendTyping(spaceId, true);
  }

  try {
    await dispatchInboundReplyWithBase({
      cfg: config,
      channel: CHANNEL_ID,
      accountId: "default",
      route,
      storePath,
      ctxPayload,
      core,
      deliver: async (replyPayload) => {
        const text = replyPayload.text || "";
        if (!text || !client) return;
        // Final delivery — send through the normal path (persisted message)
        client.sendReply(spaceId, text);
      },
      onRecordError: (err) => {
        runtime.error?.(`startup-suite: session meta error: ${String(err)}`);
      },
      onDispatchError: (err, info) => {
        runtime.error?.(`startup-suite ${info.kind} reply failed: ${String(err)}`);
      },
      replyOptions: {
        onPartialReply: (payload) => {
          const text = payload.text || "";
          if (text && text !== lastChunkText) {
            scheduleFlush(text);
          }
        },
      },
    });

    // Signal streaming done so UI clears the streaming bubble
    flushChunk(lastChunkText || "", true);
  } catch (err: any) {
    runtime.error?.(
      `[suite-inbound] dispatch failed: reason=${signalReason} task=${taskId} error=${String(err)}`
    );
  } finally {
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    if (!isOrchestrated) {
      client.sendTyping(spaceId, false);
    }
  }
}
