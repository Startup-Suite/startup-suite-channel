// @ts-ignore phoenix ships JS without local type declarations in this plugin checkout
import { Socket } from "phoenix";
import WebSocket from "ws";

export interface SuiteConfig {
  url: string;
  runtimeId: string;
  token: string;
  autoJoinSpaces: string[];
  reconnectIntervalMs: number;
  maxReconnectIntervalMs: number;
}

export interface SuiteHandlers {
  onAttention: (payload: AttentionPayload) => void;
  onToolResult: (payload: { call_id: string; status?: string; result?: unknown; error?: { error?: string } }) => void;
  onDisconnect: () => void;
  onSpacesManifest?: (spaces: Array<{ id: string; name: string; kind: string }>) => void;
}

export interface AttentionPayload {
  signal: { reason: string; space_id?: string; task_id?: string; task_status?: string; message_id?: string };
  message: { content: string; author: string };
  history: Array<{ content: string; author: string; role?: string }>;
  context: {
    // Chat attention context (from ContextPlane)
    space?: { id: string; name: string; description?: string };
    canvases?: Array<{ id: string; title: string; content: string }>;
    tasks?: Array<{ id: string; title: string; status: string }>;
    agents?: Array<{ id: string; name: string; status: string }>;
    activity_summary?: string;
    // Task orchestration context (from ContextAssembler)
    project?: {
      name: string;
      repo_url?: string;
      tech_stack?: Record<string, unknown>;
      deploy_config?: Record<string, unknown>;
    };
    epic?: {
      name: string;
      description?: string;
      acceptance_criteria?: string;
    };
    task?: {
      id: string;
      title: string;
      description?: string;
      status: string;
      priority?: string;
      dependencies?: Array<Record<string, unknown>>;
      metadata?: Record<string, unknown>;
    };
    plan?: {
      id: string;
      version: number;
      status: string;
      stages: Array<{
        id: string;
        position: number;
        name: string;
        description?: string;
        status: string;
        validations: Array<{ id: string; kind: string; status: string }>;
      }>;
    };
    execution_space_id?: string;
    skills?: Array<{ name: string; content: string }>;
    // Org-level context bundle (from Platform.Org.Context.build_context/1)
    // Keys are file names: ORG_IDENTITY.md, ORG_MEMORY.md, ORG_AGENTS.md,
    // and ORG_NOTES-YYYY-MM-DD for recent daily memory entries.
    org?: Record<string, string>;
  };
  tools?: Array<{ name: string; description: string; parameters: object }>;
}

export class SuiteClient {
  private socket: Socket | null = null;
  private channel: any = null;
  private config: SuiteConfig;
  private handlers: SuiteHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  private stopped: boolean = false;
  private recentMessageIds = new Set<string>();
  private pendingToolCalls = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>();

  constructor(config: SuiteConfig, handlers: SuiteHandlers) {
    this.config = config;
    this.handlers = handlers;
  }

  /**
   * Call a Suite tool over the WebSocket and wait for the result.
   */
  callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingToolCalls.delete(callId);
        reject(new Error(`Tool call ${tool} timed out after 30s`));
      }, 30_000);

      this.pendingToolCalls.set(callId, {
        resolve: (result: unknown) => { clearTimeout(timeout); resolve(result); },
        reject: (err: Error) => { clearTimeout(timeout); reject(err); },
      });

      this.channel?.push("tool_call", { call_id: callId, tool, args });
    });
  }

  connect(): void {
    this.stopped = false;

    // Clean up any existing connection first to prevent duplicate subscriptions
    if (this.channel) {
      try { this.channel.leave(); } catch {}
      this.channel = null;
    }
    if (this.socket) {
      try { this.socket.disconnect(); } catch {}
      this.socket = null;
    }

    // Phoenix JS client needs a WebSocket implementation in Node.js
    (globalThis as any).WebSocket = WebSocket;

    this.socket = new Socket(this.config.url, {
      params: {
        runtime_id: this.config.runtimeId,
        token: this.config.token,
      },
      // Disable Phoenix's built-in reconnect — we handle it ourselves
      reconnectAfterMs: () => 999999999,
    });

    this.socket.onOpen(() => {
      console.log(`[suite-client] Socket opened (attempt ${this.reconnectAttempts} resets to 0)`);
      this.reconnectAttempts = 0;
    });

    this.socket.onClose((event: any) => {
      console.warn(`[suite-client] Socket closed — code: ${event?.code ?? "unknown"}, reason: ${event?.reason || "none"}, wasClean: ${event?.wasClean ?? "unknown"}`);
      if (!this.stopped) {
        this.handlers.onDisconnect();
        this.scheduleReconnect();
      }
    });

    this.socket.onError((error: any) => {
      console.error(`[suite-client] Socket error:`, error?.message || error);
      if (!this.stopped) {
        this.handlers.onDisconnect();
      }
    });

    this.socket.connect();
    this.joinChannel();
  }

  disconnect(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.channel) {
      this.channel.leave();
      this.channel = null;
    }

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  sendReply(spaceId: string, content: string): void {
    this.channel?.push("reply", { space_id: spaceId, content });
  }

  sendTyping(spaceId: string, typing: boolean): void {
    this.channel?.push("typing", { space_id: spaceId, typing });
  }

  sendReplyChunk(spaceId: string, chunkId: string, text: string, done: boolean): void {
    this.channel?.push("reply_chunk", {
      space_id: spaceId,
      chunk_id: chunkId,
      text,
      done,
    });
  }

  sendToolCall(callId: string, tool: string, args: object): void {
    this.channel?.push("tool_call", { call_id: callId, tool, args });
  }

  sendUsageEvent(event: Record<string, unknown>): void {
    this.channel?.push("usage_event", event);
  }

  sendExecutionEvent(event: Record<string, unknown>): void {
    this.channel?.push("execution_event", event);
  }

  sendReplyWithMedia(
    spaceId: string,
    content: string,
    attachments: Array<{
      filename: string;
      contentType: string;
      data: string; // base64
    }>
  ): void {
    this.channel?.push("reply_with_media", {
      space_id: spaceId,
      content,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content_type: a.contentType,
        data: a.data,
      })),
    });
  }

  private joinChannel(): void {
    if (!this.socket) return;

    const topic = `runtime:${this.config.runtimeId}`;
    this.channel = this.socket.channel(topic, {});

    this.channel.on("capabilities", (payload: { tools: any[]; tool_count: number }) => {
      const registered = [
        "suite_canvas_create",
        "suite_canvas_update",
        "suite_send_media",
        "suite_project_list",
        "suite_epic_list",
        "suite_task_create",
        "suite_task_get",
        "suite_task_list",
        "suite_task_update",
        "suite_task_complete",
        "suite_plan_create",
        "suite_plan_get",
        "suite_plan_submit",
        "suite_stage_start",
        "suite_stage_list",
        "suite_validation_evaluate",
        "validation_pass",
        "stage_complete",
        "report_blocker",
        "suite_validation_list",
        "review_request_create",
        "suite_review_request_create",
        "suite_space_list",
        "suite_space_get_context",
        "space_get_context",
        "suite_space_search_messages",
        "space_search_messages",
        "suite_space_get_messages",
        "space_get_messages",
        "suite_canvas_list",
        "canvas_list",
        "suite_canvas_get",
        "canvas_get",
        "prompt_template_list",
        "suite_prompt_template_list",
        "prompt_template_update",
        "suite_prompt_template_update",
        "suite_federation_status",
        "suite_org_context_read",
        "suite_org_context_write",
        "suite_org_context_list",
        "suite_org_memory_append",
        "suite_org_memory_search",
      ];
      const available = (payload.tools || []).map((t: any) => t.name);
      const unregistered = available.filter(
        (t: string) => !registered.includes(t) && !registered.includes(`suite_${t}`)
      );
      if (unregistered.length > 0) {
        console.warn(`[suite-client] Suite advertises tools not registered in plugin: ${unregistered.join(", ")}. Update the plugin to add these.`);
      }
      console.log(`[suite-client] Suite capabilities: ${payload.tool_count} tools available, ${registered.length} registered in plugin`);
    });

    this.channel.on("attention", (payload: AttentionPayload) => {
      // Deduplicate — Suite may broadcast once but multiple channel joins can receive it
      const msgId = payload.signal?.message_id || payload.message?.content?.slice(0, 50) || "";
      const dedupeKey = `${payload.signal?.space_id}:${msgId}:${Date.now() >> 10}`; // ~1s window
      if (this.recentMessageIds.has(dedupeKey)) return;
      this.recentMessageIds.add(dedupeKey);
      // Clean old entries
      if (this.recentMessageIds.size > 50) {
        const first = this.recentMessageIds.values().next().value;
        if (first) this.recentMessageIds.delete(first);
      }
      this.handlers.onAttention(payload);
    });

    this.channel.on("tool_result", (payload: { call_id: string; status: string; result?: unknown; error?: { error?: string } }) => {
      const pending = this.pendingToolCalls.get(payload.call_id);
      if (pending) {
        this.pendingToolCalls.delete(payload.call_id);
        if (payload.status === "ok") {
          pending.resolve(payload.result);
        } else {
          pending.reject(new Error(payload.error?.error || "Tool call failed"));
        }
      }
      this.handlers.onToolResult(payload);
    });

    this.channel.on("spaces_manifest", (payload: { spaces: Array<{ id: string; name: string; kind: string }> }) => {
      console.log(`[suite-client] spaces_manifest: ${payload.spaces.length} spaces`);
      this.handlers.onSpacesManifest?.(payload.spaces);
    });

    this.channel.on("ping", (_payload: { timestamp?: string }) => {
      this.channel?.push("pong", { timestamp: new Date().toISOString() });
    });

    this.channel
      .join()
      .receive("ok", () => {
        console.log(`[suite-client] Joined ${topic}`);
      })
      .receive("error", (reason: unknown) => {
        console.error(`[suite-client] Failed to join ${topic}:`, reason);
      });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const delay = Math.min(
      this.config.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectIntervalMs
    );

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);

    console.log(`[suite-client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
  }
}
