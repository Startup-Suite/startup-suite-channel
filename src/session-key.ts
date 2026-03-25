export type TaskPhase = "planning" | "execution" | "review";

export function parseTaskSessionKey(sessionKey?: string | null):
  | { taskId: string; phase: TaskPhase }
  | null {
  if (!sessionKey) return null;
  const prefix = "startup-suite:task:";
  if (!sessionKey.startsWith(prefix)) return null;

  const rest = sessionKey.slice(prefix.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0) return null;

  const taskId = rest.slice(0, lastColon);
  const phase = rest.slice(lastColon + 1) as TaskPhase;
  if (!taskId || !["planning", "execution", "review"].includes(phase)) return null;
  return { taskId, phase };
}
