import { type OpenClawConfig, type RuntimeEnv } from "./runtime-api.js";
import { getSuiteRuntime } from "./runtime.js";
import { getTaskWorkers, getSessionContextCache } from "./plugin-state.js";
import { buildTaskSessionKey, type TaskPhase } from "./session-key.js";
import type { AttentionPayload } from "./suite-client.js";
import type { SuiteClient } from "./suite-client.js";

const CHANNEL_ID = "startup-suite";

export async function handleSuiteInbound(params: {
  payload: AttentionPayload;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  client: SuiteClient;
  accountId: string;
}): Promise<void> {
  const { payload, config, runtime, client, accountId } = params;
  const core = getSuiteRuntime();

  const rawBody = payload.message?.content?.trim() ?? "";
  if (!rawBody) {
    runtime.log(`[suite-inbound] empty message body, signal=${payload.signal?.reason} task=${payload.signal?.task_id}`);
    return;
  }

  // Classify the signal. Any attention payload carrying a task_id is treated as
  // task-scoped orchestration, including human steering messages posted into an
  // execution space.
  const taskId = payload.signal?.task_id;
  const taskStatus = payload.signal?.task_status;
  const signalReason = payload.signal?.reason;
  const isLifecycleSignal = !!(
    signalReason &&
    (signalReason === "task_assigned" || signalReason === "task_heartbeat")
  );
  const isOrchestrated = !!taskId;

  // For orchestrated signals, the signal.space_id is the execution space which
  // isn't in the agent's routing config. Use the execution space for replies but
  // route via a synthetic peer so the default agent binding resolves correctly.
  const spaceId = payload.signal.space_id || payload.signal.task_id || "unknown";

  const senderId = payload.message.author || (isLifecycleSignal ? "TaskRouter" : "unknown");
  const senderName = payload.message.author || (isLifecycleSignal ? "TaskRouter" : "unknown");
  const isGroup = true;

  // Resolve agent route.
  // For orchestrated signals, use "orchestration" as the peer ID so the route
  // resolver falls through to the default agent binding. Execution space IDs
  // aren't in the routing config and would cause a mismatch.
  const routePeerId = isOrchestrated ? "orchestration" : spaceId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId,
    peer: {
      kind: "group",
      id: routePeerId,
    },
  });

  // Store spaceId to accountId mapping for tools
  const { rememberSpaceAccount } = await import("./plugin-state.js");
  rememberSpaceAccount(spaceId, accountId);

  runtime.log(
    `[suite-inbound] reason=${signalReason || "chat"} task=${taskId || "none"} ` +
    `space=${spaceId} orchestrated=${isOrchestrated}`
  );

  // Store the Suite context in the cache for dynamic injection via before_prompt_build hook
  // The cache handles selective injection (only first message, after gaps, or near context limits)
  const sessionKey = route.sessionKey;
  const sessionContextCache = getSessionContextCache();
  sessionContextCache.setContext(sessionKey, payload.context);

  // Simple enriched body - context is now injected via OpenClaw hooks
  const enrichedBody = `**${senderName}**: ${rawBody}`;

  function resolveTaskPhase(reason: string, status?: string): TaskPhase {
    if (reason === "task_assigned" && status === "planning") return "planning";
    if (status === "in_review") return "review";
    if (status === "deploying") return "deploying";
    return "execution";
  }

  const phase = isOrchestrated && taskId ? resolveTaskPhase(signalReason!, taskStatus) : null;

  // Override session key for orchestrated task signals — isolates context per task per phase.
  // If a prior run for the same task/phase blocked or failed, ensureWorker may freshen
  // the session key so retries get a clean agent context instead of reusing poisoned state.
  if (phase && taskId) {
    const workers = getTaskWorkers();
    const sessionKey =
      phase === "review"
        ? buildTaskSessionKey(taskId, phase, Date.now())
        : buildTaskSessionKey(taskId, phase);

    let worker = workers.ensureWorker({
      taskId,
      phase,
      executionSpaceId: spaceId,
      sessionKey,
    });

    if (phase === "review" && signalReason === "task_assigned") {
      worker = workers.forceFreshSession(taskId, phase, sessionKey) ?? worker;
    }

    route.sessionKey = worker.sessionKey;
    runtime.log(
      `[suite-inbound] task-route override: task=${taskId} phase=${phase} requested=${sessionKey} worker=${worker.sessionKey}`
    );

    if (signalReason === "task_heartbeat") {
      workers.noteHeartbeat(taskId, phase, "heartbeat acknowledged", {
        sessionKey: route.sessionKey,
      });
    }
  }

  runtime.log(
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

  try {
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: ctxPayload,
      createIfMissing: true,
      updateLastRoute: {
        sessionKey: route.sessionKey,
        channel: CHANNEL_ID,
        to: `startup-suite:${spaceId}`,
        accountId,
      },
      onRecordError: (err: unknown) => {
        runtime.error(`startup-suite: session meta error: ${String(err)}`);
      },
    });

    const { dispatcher, replyOptions: dispatcherReplyOptions, markDispatchIdle, markRunComplete } =
      core.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (replyPayload: any, info: { kind: string }) => {
          const text = replyPayload?.text || "";
          if (!text || !client) return;

          if (info.kind !== "tool") {
            client.sendReply(spaceId, text);
          }

          // Task-phase completion is now driven by real lifecycle/tool events
          // (session_start / llm_input / after_tool_call / agent_end), not by the
          // presence of a final reply string.
        },
        typingCallbacks: undefined,
        onError: (err: unknown, info: { kind: string }) => {
          runtime.error(`startup-suite ${info.kind} reply failed: ${String(err)}`);
        },
        onCleanup: () => {
          if (!isOrchestrated) {
            client.sendTyping(spaceId, false);
          }
        },
      });

    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: config,
      dispatcher,
      replyOptions: {
        ...dispatcherReplyOptions,
        onPartialReply: (payload: any) => {
          const text = payload.text || "";
          if (text && text !== lastChunkText) {
            scheduleFlush(text);
            if (phase && taskId) {
              getTaskWorkers().noteProgress(taskId, phase, "streaming reply chunk");
            }
          }
        },
      },
    });

    markRunComplete();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    markDispatchIdle();

    // Signal streaming done so UI clears the streaming bubble
    flushChunk(lastChunkText || "", true);
  } catch (err: any) {
    if (phase && taskId) {
      getTaskWorkers().noteFailure(taskId, phase, String(err));
    }

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
