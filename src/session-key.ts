export type TaskPhase = "planning" | "execution" | "review" | "deploying";

export function buildTaskSessionKey(taskId: string, phase: TaskPhase, attempt?: string | number) {
  const base = `startup-suite:task:${taskId}:${phase}`;
  return attempt == null ? base : `${base}:attempt:${attempt}`;
}

export function parseTaskSessionKey(sessionKey?: string | null):
  | { taskId: string; phase: TaskPhase }
  | null {
  if (!sessionKey) return null;
  const prefix = "startup-suite:task:";
  if (!sessionKey.startsWith(prefix)) return null;

  const rest = sessionKey.slice(prefix.length);
  const match = rest.match(/^([^:]+):(planning|execution|review|deploying)(?::.*)?$/);
  if (!match) return null;

  return { taskId: match[1]!, phase: match[2] as TaskPhase };
}
