import type { SuiteClient } from "./suite-client.js";
import type { TaskPhase } from "./session-key.js";

interface TaskWorkerRecord {
  key: string;
  taskId: string;
  phase: TaskPhase;
  executionSpaceId: string;
  sessionKey: string;
  runtimeWorkerRef: string;
  sessionId?: string;
  runId?: string;
  assignmentAcceptedSent: boolean;
  executionStartedSent: boolean;
  status: "active" | "blocked" | "finished" | "failed" | "abandoned";
  createdAt: number;
  lastObservedAt: number;
  lastHeartbeatSentAt: number;
  lastProgressSentAt: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

interface RuntimeEventPayload {
  taskId: string;
  phase: TaskPhase;
  eventType:
    | "assignment.accepted"
    | "execution.started"
    | "execution.heartbeat"
    | "execution.progress"
    | "execution.blocked"
    | "execution.finished"
    | "execution.failed"
    | "execution.abandoned";
  executionSpaceId?: string;
  runtimeWorkerRef?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
}

export class TaskWorkerController {
  private readonly workers = new Map<string, TaskWorkerRecord>();
  private readonly heartbeatIntervalMs: number;
  private readonly progressThrottleMs: number;

  constructor(
    private readonly getClient: (executionSpaceId?: string) => SuiteClient | null,
    opts?: { heartbeatIntervalMs?: number; progressThrottleMs?: number }
  ) {
    this.heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? 60_000;
    this.progressThrottleMs = opts?.progressThrottleMs ?? 15_000;
  }

  ensureWorker(params: {
    taskId: string;
    phase: TaskPhase;
    executionSpaceId: string;
    sessionKey: string;
  }): TaskWorkerRecord {
    this.finishOtherPhases(params.taskId, params.phase);

    const key = this.workerKey(params.taskId, params.phase);
    let worker = this.workers.get(key);
    const now = Date.now();

    if (!worker) {
      worker = {
        key,
        taskId: params.taskId,
        phase: params.phase,
        executionSpaceId: params.executionSpaceId,
        sessionKey: params.sessionKey,
        runtimeWorkerRef: params.sessionKey,
        assignmentAcceptedSent: false,
        executionStartedSent: false,
        status: "active",
        createdAt: now,
        lastObservedAt: now,
        lastHeartbeatSentAt: 0,
        lastProgressSentAt: 0,
      };
      this.workers.set(key, worker);
      return worker;
    }

    const shouldFreshenSession = ["blocked", "failed", "finished", "abandoned"].includes(worker.status);

    if (shouldFreshenSession) {
      this.stopHeartbeat(worker);
      worker.sessionKey = `${params.sessionKey}:attempt:${now}`;
      worker.runtimeWorkerRef = worker.sessionKey;
      worker.sessionId = undefined;
      worker.runId = undefined;
      worker.assignmentAcceptedSent = false;
      worker.executionStartedSent = false;
      worker.createdAt = now;
      worker.lastHeartbeatSentAt = 0;
      worker.lastProgressSentAt = 0;
    } else if (!worker.sessionKey) {
      worker.sessionKey = params.sessionKey;
      if (!worker.sessionId) {
        worker.runtimeWorkerRef = params.sessionKey;
      }
    }

    worker.executionSpaceId = params.executionSpaceId;
    worker.status = "active";
    worker.lastObservedAt = now;
    return worker;
  }

  forceFreshSession(taskId: string, phase: TaskPhase, sessionKey: string) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return null;
    const now = Date.now();
    this.stopHeartbeat(worker);
    worker.sessionKey = sessionKey;
    worker.runtimeWorkerRef = sessionKey;
    worker.sessionId = undefined;
    worker.runId = undefined;
    worker.assignmentAcceptedSent = false;
    worker.executionStartedSent = false;
    worker.status = "active";
    worker.createdAt = now;
    worker.lastObservedAt = now;
    worker.lastHeartbeatSentAt = 0;
    worker.lastProgressSentAt = 0;
    return worker;
  }

  noteSessionStarted(
    taskId: string,
    phase: TaskPhase,
    details: { sessionId?: string; runId?: string; sessionKey?: string }
  ) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    const now = Date.now();
    if (!this.observeRuntime(worker, details)) return;
    worker.lastObservedAt = now;

    if (!worker.assignmentAcceptedSent) {
      worker.assignmentAcceptedSent = true;
      this.publish({
        taskId,
        phase,
        eventType: "assignment.accepted",
        executionSpaceId: worker.executionSpaceId,
        runtimeWorkerRef: worker.runtimeWorkerRef,
        idempotencyKey: `${taskId}:${phase}:assignment.accepted:${worker.runtimeWorkerRef}`,
        payload: this.runtimeIdentityPayload(worker),
      });
    }
  }

  notePromptDelivered(
    taskId: string,
    phase: TaskPhase,
    details: { sessionId?: string; runId?: string; sessionKey?: string; summary?: string }
  ) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    const now = Date.now();
    if (!this.observeRuntime(worker, details)) return;
    worker.lastObservedAt = now;

    if (!worker.assignmentAcceptedSent) {
      this.noteSessionStarted(taskId, phase, details);
    }

    if (!worker.executionStartedSent) {
      worker.executionStartedSent = true;
      this.publish({
        taskId,
        phase,
        eventType: "execution.started",
        executionSpaceId: worker.executionSpaceId,
        runtimeWorkerRef: worker.runtimeWorkerRef,
        idempotencyKey: `${taskId}:${phase}:execution.started:${worker.runId ?? worker.runtimeWorkerRef}`,
        payload: {
          ...this.runtimeIdentityPayload(worker),
          ...(details.summary ? { summary: details.summary } : {}),
        },
      });
    }

    if (!worker.heartbeatTimer) {
      worker.lastHeartbeatSentAt = now;
      this.startHeartbeat(worker);
    }
  }

  noteProgress(
    taskId: string,
    phase: TaskPhase,
    summary?: string,
    details?: { sessionId?: string; runId?: string; sessionKey?: string; idempotencyKey?: string }
  ) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    const now = Date.now();
    if (!this.observeRuntime(worker, details ?? {})) return;
    worker.lastObservedAt = now;
    if (!worker.executionStartedSent) {
      this.notePromptDelivered(taskId, phase, {
        ...details,
        summary: summary ?? "runtime activity observed",
      });
    }
    if (now - worker.lastProgressSentAt < this.progressThrottleMs) return;
    worker.lastProgressSentAt = now;
    worker.lastHeartbeatSentAt = now;
    if (!worker.heartbeatTimer) this.startHeartbeat(worker);
    this.publish({
      taskId,
      phase,
      eventType: "execution.progress",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      idempotencyKey:
        details?.idempotencyKey ??
        `${taskId}:${phase}:execution.progress:${worker.runId ?? worker.runtimeWorkerRef}:${Math.floor(now / this.progressThrottleMs)}`,
      payload: {
        ...this.runtimeIdentityPayload(worker),
        ...(summary ? { summary } : {}),
      },
    });
  }

  noteHeartbeat(
    taskId: string,
    phase: TaskPhase,
    summary?: string,
    details?: { sessionId?: string; runId?: string; sessionKey?: string }
  ) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    const now = Date.now();
    if (!this.observeRuntime(worker, details ?? {})) return;
    worker.lastObservedAt = now;
    worker.lastHeartbeatSentAt = now;
    if (!worker.executionStartedSent) {
      this.notePromptDelivered(taskId, phase, {
        ...details,
        summary: summary ?? "heartbeat acknowledged",
      });
    }
    if (!worker.heartbeatTimer) this.startHeartbeat(worker);
    this.publish({
      taskId,
      phase,
      eventType: "execution.heartbeat",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      idempotencyKey: `${taskId}:${phase}:execution.heartbeat:${worker.runId ?? worker.runtimeWorkerRef}:${Math.floor(now / this.heartbeatIntervalMs)}`,
      payload: {
        ...this.runtimeIdentityPayload(worker),
        ...(summary ? { summary } : {}),
        last_local_activity_at: new Date(worker.lastObservedAt).toISOString(),
        status: worker.status,
      },
    });
  }

  noteFailure(
    taskId: string,
    phase: TaskPhase,
    error: string,
    details?: { sessionId?: string; runId?: string; sessionKey?: string; idempotencyKey?: string }
  ) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    if (!this.observeRuntime(worker, details ?? {})) return;
    worker.status = "failed";
    worker.lastObservedAt = Date.now();
    this.publish({
      taskId,
      phase,
      eventType: "execution.failed",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      idempotencyKey:
        details?.idempotencyKey ?? `${taskId}:${phase}:execution.failed:${worker.runId ?? worker.runtimeWorkerRef}`,
      payload: {
        ...this.runtimeIdentityPayload(worker),
        error,
      },
    });
    this.stopHeartbeat(worker);
  }

  noteBlocked(
    taskId: string,
    phase: TaskPhase,
    description: string,
    details?: { sessionId?: string; runId?: string; sessionKey?: string; idempotencyKey?: string }
  ) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    if (!this.observeRuntime(worker, details ?? {})) return;
    worker.status = "blocked";
    worker.lastObservedAt = Date.now();
    this.publish({
      taskId,
      phase,
      eventType: "execution.blocked",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      idempotencyKey:
        details?.idempotencyKey ?? `${taskId}:${phase}:execution.blocked:${worker.runId ?? worker.runtimeWorkerRef}`,
      payload: {
        ...this.runtimeIdentityPayload(worker),
        description,
      },
    });
  }

  noteFinished(
    taskId: string,
    phase: TaskPhase,
    summary?: string,
    details?: { sessionId?: string; runId?: string; sessionKey?: string; idempotencyKey?: string }
  ) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    if (!this.observeRuntime(worker, details ?? {})) return;
    worker.status = "finished";
    worker.lastObservedAt = Date.now();
    this.publish({
      taskId,
      phase,
      eventType: "execution.finished",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      idempotencyKey:
        details?.idempotencyKey ?? `${taskId}:${phase}:execution.finished:${worker.runId ?? worker.runtimeWorkerRef}`,
      payload: {
        ...this.runtimeIdentityPayload(worker),
        ...(summary ? { summary } : {}),
      },
    });
    this.stopHeartbeat(worker);
  }

  noteAbandoned(
    taskId: string,
    phase: TaskPhase,
    reason?: string,
    details?: { sessionId?: string; runId?: string; sessionKey?: string; idempotencyKey?: string }
  ) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    if (!this.observeRuntime(worker, details ?? {})) return;
    worker.status = "abandoned";
    worker.lastObservedAt = Date.now();
    this.publish({
      taskId,
      phase,
      eventType: "execution.abandoned",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      idempotencyKey:
        details?.idempotencyKey ?? `${taskId}:${phase}:execution.abandoned:${worker.runId ?? worker.runtimeWorkerRef}`,
      payload: {
        ...this.runtimeIdentityPayload(worker),
        ...(reason ? { reason } : {}),
      },
    });
    this.stopHeartbeat(worker);
  }

  resolveExecutionSpaceId(sessionKey?: string | null): string | undefined {
    if (!sessionKey) return undefined;
    for (const worker of this.workers.values()) {
      if (worker.sessionKey === sessionKey) return worker.executionSpaceId;
    }
    return undefined;
  }

  shutdown(reason = "runtime disconnected") {
    for (const worker of this.workers.values()) {
      if (worker.status === "active" || worker.status === "blocked") {
        this.publish({
          taskId: worker.taskId,
          phase: worker.phase,
          eventType: "execution.abandoned",
          executionSpaceId: worker.executionSpaceId,
          runtimeWorkerRef: worker.runtimeWorkerRef,
          payload: { reason },
        });
      }
      this.stopHeartbeat(worker);
    }
    this.workers.clear();
  }

  private startHeartbeat(worker: TaskWorkerRecord) {
    this.stopHeartbeat(worker);
    worker.heartbeatTimer = setInterval(() => {
      if (worker.status !== "active" && worker.status !== "blocked") return;
      const now = Date.now();
      if (now - worker.lastHeartbeatSentAt < this.heartbeatIntervalMs - 1_000) return;
      worker.lastHeartbeatSentAt = now;
      this.publish({
        taskId: worker.taskId,
        phase: worker.phase,
        eventType: "execution.heartbeat",
        executionSpaceId: worker.executionSpaceId,
        runtimeWorkerRef: worker.runtimeWorkerRef,
        idempotencyKey: `${worker.taskId}:${worker.phase}:execution.heartbeat:${worker.runId ?? worker.runtimeWorkerRef}:${Math.floor(now / this.heartbeatIntervalMs)}`,
        payload: {
          ...this.runtimeIdentityPayload(worker),
          last_local_activity_at: new Date(worker.lastObservedAt).toISOString(),
          status: worker.status,
        },
      });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(worker: TaskWorkerRecord) {
    if (worker.heartbeatTimer) {
      clearInterval(worker.heartbeatTimer);
      worker.heartbeatTimer = undefined;
    }
  }

  private finishOtherPhases(taskId: string, activePhase: TaskPhase) {
    for (const worker of this.workers.values()) {
      if (worker.taskId !== taskId || worker.phase === activePhase) continue;
      if (worker.status === "finished" || worker.status === "abandoned") continue;

      worker.status = "finished";
      worker.lastObservedAt = Date.now();
      this.publish({
        taskId: worker.taskId,
        phase: worker.phase,
        eventType: "execution.finished",
        executionSpaceId: worker.executionSpaceId,
        runtimeWorkerRef: worker.runtimeWorkerRef,
        idempotencyKey: `${worker.taskId}:${worker.phase}:execution.finished:${worker.runId ?? worker.runtimeWorkerRef}:phase-advanced-${activePhase}`,
        payload: {
          ...this.runtimeIdentityPayload(worker),
          summary: `phase advanced to ${activePhase}`,
        },
      });
      this.stopHeartbeat(worker);
    }
  }

  private observeRuntime(
    worker: TaskWorkerRecord,
    details: { sessionId?: string; runId?: string; sessionKey?: string }
  ): boolean {
    if (this.isSupersededRuntime(worker, details)) {
      return false;
    }
    if (details.sessionKey) {
      worker.sessionKey = details.sessionKey;
    }
    if (details.sessionId) {
      worker.sessionId = details.sessionId;
      worker.runtimeWorkerRef = details.sessionId;
    }
    if (details.runId) {
      worker.runId = details.runId;
    }
    return true;
  }

  private isSupersededRuntime(
    worker: TaskWorkerRecord,
    details: { sessionId?: string; runId?: string; sessionKey?: string }
  ) {
    if (details.sessionId && worker.sessionId && details.sessionId !== worker.sessionId) {
      return true;
    }

    if (details.sessionKey && worker.sessionKey && details.sessionKey !== worker.sessionKey) {
      return true;
    }

    if (details.runId && worker.runId && details.runId !== worker.runId) {
      return true;
    }

    return false;
  }

  private runtimeIdentityPayload(worker: TaskWorkerRecord): Record<string, unknown> {
    return {
      ...(worker.sessionKey ? { session_key: worker.sessionKey } : {}),
      ...(worker.sessionId ? { session_id: worker.sessionId } : {}),
      ...(worker.runId ? { run_id: worker.runId } : {}),
    };
  }

  private publish(event: RuntimeEventPayload) {
    const client = this.getClient(event.executionSpaceId);
    if (!client) return;

    client.sendExecutionEvent({
      task_id: event.taskId,
      phase: event.phase,
      event_type: event.eventType,
      execution_space_id: event.executionSpaceId,
      runtime_worker_ref: event.runtimeWorkerRef,
      occurred_at: new Date().toISOString(),
      idempotency_key: event.idempotencyKey ?? this.idempotencyKey(event),
      payload: event.payload ?? {},
    });
  }

  private idempotencyKey(event: RuntimeEventPayload): string {
    return [
      event.taskId,
      event.phase,
      event.eventType,
      event.runtimeWorkerRef ?? "worker",
    ].join(":");
  }

  private workerKey(taskId: string, phase: TaskPhase) {
    return `${taskId}:${phase}`;
  }
}
