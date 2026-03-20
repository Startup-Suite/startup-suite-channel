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
  onToolResult: (payload: { call_id: string; result: unknown }) => void;
  onDisconnect: () => void;
}

export interface AttentionPayload {
  signal: { reason: string; space_id: string };
  message: { content: string; author: string };
  history: Array<{ content: string; author: string; role?: string }>;
  context: {
    space: { id: string; name: string; description?: string };
    canvases?: Array<{ id: string; title: string; content: string }>;
    tasks?: Array<{ id: string; title: string; status: string }>;
    agents?: Array<{ id: string; name: string; status: string }>;
    activity_summary?: string;
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
      this.reconnectAttempts = 0;
    });

    this.socket.onClose(() => {
      if (!this.stopped) {
        this.handlers.onDisconnect();
        this.scheduleReconnect();
      }
    });

    this.socket.onError(() => {
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

  sendToolCall(callId: string, tool: string, args: object): void {
    this.channel?.push("tool_call", { call_id: callId, tool, args });
  }

  private joinChannel(): void {
    if (!this.socket) return;

    const topic = `runtime:${this.config.runtimeId}`;
    this.channel = this.socket.channel(topic, {});

    this.channel.on("capabilities", (payload: { tools: any[]; tool_count: number }) => {
      const registered = ["suite_canvas_create", "suite_canvas_update", "suite_task_create", "suite_task_complete"];
      const available = (payload.tools || []).map((t: any) => t.name);
      const unregistered = available.filter((t: string) => !registered.includes(`suite_${t}`));
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
