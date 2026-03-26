import type { AttentionPayload } from "./suite-client.js";

/**
 * Build a markdown preamble from Suite space context.
 * Used by the inbound handler to enrich the agent envelope body.
 *
 * Handles two context shapes:
 * - Chat attention (ContextPlane): space, canvases, tasks, agents, activity_summary
 * - Task orchestration (ContextAssembler): project, epic, task, plan, skills
 */
export function formatContextPreamble(context: AttentionPayload["context"]): string {
  const lines: string[] = [];

  // ── Space context (chat attention) ──────────────────────────────────
  if (context.space) {
    lines.push(`## Space: ${context.space.name}`);
    if (context.space.description) {
      lines.push(context.space.description);
    }
    lines.push("");
    lines.push(`[Suite Context]`);
    lines.push(`Space ID: ${context.space.id}`);
    lines.push(`(use this space_id when calling suite_canvas_create, suite_canvas_update, suite_send_media, suite_task_create, suite_task_get, suite_task_list, suite_task_update, suite_task_complete, suite_plan_create, suite_plan_get, suite_plan_submit, suite_stage_start, suite_stage_list, suite_validation_evaluate, suite_validation_list, stage_complete, report_blocker, or suite_review_request_create)`);
    lines.push("");
  }

  // ── Task orchestration context (ContextAssembler) ───────────────────
  if (context.project) {
    lines.push("### Project");
    lines.push(`- **Name:** ${context.project.name}`);
    if (context.project.repo_url) {
      lines.push(`- **Repo:** ${context.project.repo_url}`);
    }
    if (context.project.tech_stack && Object.keys(context.project.tech_stack).length > 0) {
      lines.push(`- **Tech Stack:** ${JSON.stringify(context.project.tech_stack)}`);
    }
    lines.push("");
  }

  if (context.epic) {
    lines.push("### Epic");
    lines.push(`- **Name:** ${context.epic.name}`);
    if (context.epic.description) {
      lines.push(`- **Description:** ${context.epic.description}`);
    }
    if (context.epic.acceptance_criteria) {
      lines.push(`- **Acceptance Criteria:** ${context.epic.acceptance_criteria}`);
    }
    lines.push("");
  }

  if (context.task) {
    lines.push("### Task");
    lines.push(`- **Title:** ${context.task.title}`);
    lines.push(`- **ID:** ${context.task.id}`);
    lines.push(`- **Status:** ${context.task.status}`);
    if (context.task.priority) {
      lines.push(`- **Priority:** ${context.task.priority}`);
    }
    if (context.task.description) {
      lines.push(`- **Description:** ${context.task.description}`);
    }
    if (context.task.dependencies?.length) {
      lines.push(`- **Dependencies:** ${JSON.stringify(context.task.dependencies)}`);
    }
    lines.push("");
  }

  if (context.plan) {
    lines.push("### Plan");
    lines.push(`- **Plan ID:** ${context.plan.id} (v${context.plan.version}, ${context.plan.status})`);
    if (context.plan.stages?.length) {
      lines.push("- **Stages:**");
      for (const stage of context.plan.stages) {
        const validationSummary = stage.validations?.length
          ? ` — validations: ${stage.validations.map((v) => `${v.kind}(${v.status})`).join(", ")}`
          : "";
        lines.push(`  ${stage.position}. **${stage.name}** [${stage.status}]${stage.description ? `: ${stage.description}` : ""}${validationSummary}`);
      }
    }
    lines.push("");
  }

  if (context.skills?.length) {
    lines.push("### Attached Skills");
    for (const skill of context.skills) {
      lines.push(`<details><summary>${skill.name}</summary>\n\n${skill.content}\n</details>`);
    }
    lines.push("");
  }

  // ── Chat context items ──────────────────────────────────────────────
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
