import type { AttentionPayload } from "./suite-client.js";

export interface BridgedMessage {
  sessionKey: string;
  message: {
    role: string;
    content: string;
  };
  metadata: {
    spaceId: string;
    author: string;
    reason: string;
    tools?: Array<{ name: string; description: string; parameters: object }>;
    history?: Array<{ content: string; author: string; role?: string }>;
  };
}

export function formatContextPreamble(context: AttentionPayload["context"]): string {
  const lines: string[] = [];

  if (context.space) {
    lines.push(`## Space: ${context.space.name}`);
    if (context.space.description) {
      lines.push(context.space.description);
    }
    lines.push("");
    lines.push(`[Suite Context]`);
    lines.push(`Space ID: ${context.space.id}`);
    lines.push(`(use this space_id when calling suite_canvas_create, suite_canvas_update, suite_task_create, or suite_task_complete)`);
    lines.push("");
  }

  if (context.canvases?.length) {
    lines.push("### Canvases");
    for (const canvas of context.canvases) {
      lines.push(`- **${canvas.title}**: ${canvas.content.slice(0, 200)}${canvas.content.length > 200 ? "..." : ""}`);
    }
    lines.push("");
  }

  if (context.tasks?.length) {
    lines.push("### Tasks");
    for (const task of context.tasks) {
      lines.push(`- [${task.status}] ${task.title}`);
    }
    lines.push("");
  }

  if (context.agents?.length) {
    lines.push("### Agents");
    for (const agent of context.agents) {
      lines.push(`- ${agent.name} (${agent.status})`);
    }
    lines.push("");
  }

  if (context.activity_summary) {
    lines.push("### Recent Activity");
    lines.push(context.activity_summary);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatAttentionAsMessage(payload: AttentionPayload): BridgedMessage {
  const { signal, message, history, context, tools } = payload;

  // Inject space_id from signal into context so preamble can use it
  const enrichedContext = {
    ...context,
    space: { ...(context.space || {}), id: signal.space_id },
  };
  const preamble = formatContextPreamble(enrichedContext);

  const content = preamble
    ? `${preamble}---\n\n**${message.author}**: ${message.content}`
    : `**${message.author}**: ${message.content}`;

  return {
    sessionKey: `suite:${signal.space_id}`,
    message: {
      role: "user",
      content,
    },
    metadata: {
      spaceId: signal.space_id,
      author: message.author,
      reason: signal.reason,
      tools,
      history,
    },
  };
}
