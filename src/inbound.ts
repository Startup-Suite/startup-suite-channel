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
  if (!rawBody) return;

  const spaceId = payload.signal.space_id;
  const senderId = payload.message.author;
  const senderName = payload.message.author;
  const isGroup = true; // Suite spaces are always group-like

  // Build the enriched body with Suite context preamble
  const enrichedContext = {
    ...payload.context,
    space: { ...(payload.context?.space || { id: spaceId, name: spaceId }), id: spaceId },
  };
  const preamble = formatContextPreamble(enrichedContext);
  const enrichedBody = preamble
    ? `${preamble}---\n\n**${senderName}**: ${rawBody}`
    : `**${senderName}**: ${rawBody}`;

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: isGroup ? "group" : "direct",
      id: spaceId,
    },
  });

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
    CommandAuthorized: true, // Suite handles its own auth
  });

  // Dispatch through the full agent pipeline
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
      if (text && client) {
        client.sendReply(spaceId, text);
      }
    },
    onRecordError: (err) => {
      runtime.error?.(`startup-suite: session meta error: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`startup-suite ${info.kind} reply failed: ${String(err)}`);
    },
  });
}
