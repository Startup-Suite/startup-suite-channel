import type { AttentionPayload } from "./suite-client.js";

/**
 * Build a markdown preamble from Suite space context.
 * Used by the inbound handler to enrich the agent envelope body.
 */
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
    lines.push(`(use this space_id when calling suite_canvas_create, suite_canvas_update, suite_send_media, suite_task_create, suite_task_get, suite_task_list, suite_task_update, suite_task_complete, suite_plan_create, suite_plan_get, suite_plan_submit, suite_stage_start, suite_stage_list, suite_validation_evaluate, or suite_validation_list)`);
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
