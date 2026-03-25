import type { SuiteClient } from "./suite-client.js";
import type { TaskPhase } from "./session-key.js";

interface TaskWorkerRecord {
  key: string;
  taskId: string;
  phase: TaskPhase;
  executionSpaceId: string;
  sessionKey: string;
  runtimeWorkerRef: string;
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
        status: "active",
        createdAt: now,
        lastObservedAt: now,
        lastHeartbeatSentAt: 0,
        lastProgressSentAt: 0,
      };
      this.workers.set(key, worker);
      this.publish({
        taskId: worker.taskId,
        phase: worker.phase,
        eventType: "assignment.accepted",
        executionSpaceId: worker.executionSpaceId,
        runtimeWorkerRef: worker.runtimeWorkerRef,
      });
      this.publish({
        taskId: worker.taskId,
        phase: worker.phase,
        eventType: "execution.started",
        executionSpaceId: worker.executionSpaceId,
        runtimeWorkerRef: worker.runtimeWorkerRef,
      });
      worker.lastHeartbeatSentAt = now;
      this.startHeartbeat(worker);
      return worker;
    }

    worker.executionSpaceId = params.executionSpaceId;
    worker.sessionKey = params.sessionKey;
    worker.runtimeWorkerRef = params.sessionKey;
    worker.status = "active";
    worker.lastObservedAt = now;
    if (!worker.heartbeatTimer) this.startHeartbeat(worker);
    return worker;
  }

  noteProgress(taskId: string, phase: TaskPhase, summary?: string) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    const now = Date.now();
    worker.lastObservedAt = now;
    if (now - worker.lastProgressSentAt < this.progressThrottleMs) return;
    worker.lastProgressSentAt = now;
    worker.lastHeartbeatSentAt = now;
    this.publish({
      taskId,
      phase,
      eventType: "execution.progress",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      payload: summary ? { summary } : undefined,
    });
  }

  noteHeartbeat(taskId: string, phase: TaskPhase, summary?: string) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    const now = Date.now();
    worker.lastObservedAt = now;
    worker.lastHeartbeatSentAt = now;
    this.publish({
      taskId,
      phase,
      eventType: "execution.heartbeat",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      payload: {
        ...(summary ? { summary } : {}),
        last_local_activity_at: new Date(worker.lastObservedAt).toISOString(),
        status: worker.status,
      },
    });
  }

  noteFailure(taskId: string, phase: TaskPhase, error: string) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    worker.status = "failed";
    worker.lastObservedAt = Date.now();
    this.publish({
      taskId,
      phase,
      eventType: "execution.failed",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      payload: { error },
    });
    this.stopHeartbeat(worker);
  }

  noteBlocked(taskId: string, phase: TaskPhase, description: string) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    worker.status = "blocked";
    worker.lastObservedAt = Date.now();
    this.publish({
      taskId,
      phase,
      eventType: "execution.blocked",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      payload: { description },
    });
  }

  noteFinished(taskId: string, phase: TaskPhase, summary?: string) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    worker.status = "finished";
    worker.lastObservedAt = Date.now();
    this.publish({
      taskId,
      phase,
      eventType: "execution.finished",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      payload: summary ? { summary } : undefined,
    });
    this.stopHeartbeat(worker);
  }

  noteAbandoned(taskId: string, phase: TaskPhase, reason?: string) {
    const worker = this.workers.get(this.workerKey(taskId, phase));
    if (!worker) return;
    worker.status = "abandoned";
    worker.lastObservedAt = Date.now();
    this.publish({
      taskId,
      phase,
      eventType: "execution.abandoned",
      executionSpaceId: worker.executionSpaceId,
      runtimeWorkerRef: worker.runtimeWorkerRef,
      payload: reason ? { reason } : undefined,
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
        payload: {
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
        payload: { summary: `phase advanced to ${activePhase}` },
      });
      this.stopHeartbeat(worker);
    }
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
      idempotency_key: this.idempotencyKey(event),
      payload: event.payload ?? {},
    });
  }

  private idempotencyKey(event: RuntimeEventPayload): string {
    return [
      event.taskId,
      event.phase,
      event.eventType,
      event.runtimeWorkerRef ?? "worker",
      Date.now().toString(36),
      Math.random().toString(36).slice(2, 8),
    ].join(":");
  }

  private workerKey(taskId: string, phase: TaskPhase) {
    return `${taskId}:${phase}`;
  }
}
