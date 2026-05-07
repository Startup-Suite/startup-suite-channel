import type { AttentionPayload } from "./suite-client.js";

/**
 * Build a markdown preamble from Suite context.
 * Used by the before_prompt_build hook to inject context into the system prompt.
 *
 * Handles three context shapes (any or all may be present):
 * - Organization (Platform.Org.Context): org files + recent ORG_NOTES-*
 * - Chat attention (ContextPlane): space, canvases, tasks, agents, activity_summary
 * - Task orchestration (ContextAssembler): project, epic, task, plan, skills
 */
export function formatContextPreamble(
  context: AttentionPayload["context"],
  opts: { useMcpTools?: boolean } = {}
): string {
  const lines: string[] = [];

  // ── Organization context (shared across chat + task paths) ──────────
  if (context.org && Object.keys(context.org).length > 0) {
    const orgEntries = Object.entries(context.org);
    const files = orgEntries.filter(([key]) => !key.startsWith("ORG_NOTES-"));
    const notes = orgEntries
      .filter(([key]) => key.startsWith("ORG_NOTES-"))
      .sort(([a], [b]) => b.localeCompare(a));

    lines.push("## Organization Context");
    lines.push("");

    for (const [key, content] of files) {
      if (!content?.trim()) continue;
      lines.push(`### ${key}`);
      lines.push(content.trim());
      lines.push("");
    }

    if (notes.length > 0) {
      lines.push("### Recent Org Notes");
      for (const [key, content] of notes) {
        if (!content?.trim()) continue;
        lines.push(`**${key}**`);
        lines.push(content.trim());
        lines.push("");
      }
    }

    lines.push("### Writing to Org Memory");
    const orgMemoryAppend = opts.useMcpTools ? "org_memory_append" : "suite_org_memory_append";
    const orgContextWrite = opts.useMcpTools ? "org_context_write" : "suite_org_context_write";
    lines.push(
      `Org memory is a first-class responsibility. Record decisions and milestones future agents will care about: architectural decisions (what, why, alternatives), new integrations or dependencies, context shifts, blockers resolved (what broke, how, what to watch), and notable milestones. Use \`${orgMemoryAppend}\` for short-lived notes about today's activity (append-only, surfaces in \`ORG_NOTES-YYYY-MM-DD\`). For anything worth preserving — decisions, patterns, lessons — update \`ORG_MEMORY.md\` via \`${orgContextWrite}\`. \`ORG_MEMORY.md\` is the canonical long-term store; do not try to record long-term entries via \`${orgMemoryAppend}\`. Brief, concrete entries beat long essays — one decision per entry.`,
    );
    lines.push("");
  }

  // ── Space context (chat attention) ──────────────────────────────────
  if (context.space) {
    lines.push(`## Space: ${context.space.name}`);
    if (context.space.description) {
      lines.push(context.space.description);
    }
    lines.push("");
    lines.push(`[Suite Context]`);
    lines.push(`Space ID: ${context.space.id}`);
    if (opts.useMcpTools) {
      lines.push(`(pass this space_id when a Suite MCP tool requests it)`);
    } else {
      lines.push(`(use this space_id when calling suite_canvas_create, suite_canvas_update, suite_send_media, suite_task_create, suite_task_get, suite_task_list, suite_task_update, suite_task_complete, suite_plan_create, suite_plan_get, suite_plan_submit, suite_stage_start, suite_stage_list, suite_validation_evaluate, suite_validation_list, stage_complete, report_blocker, or suite_review_request_create)`);
    }
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
