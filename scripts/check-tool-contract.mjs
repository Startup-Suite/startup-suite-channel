import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const channelPath = path.join(repoRoot, "src", "channel.ts");
const suiteClientPath = path.join(repoRoot, "src", "suite-client.ts");

const requiredLifecycleTools = [
  "validation_pass",
  "stage_complete",
  "report_blocker",
  "suite_review_request_create",
  "review_request_create",
  "suite_prompt_template_list",
  "prompt_template_list",
  "suite_prompt_template_update",
  "prompt_template_update",
];

const requiredContextTools = [
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
];

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function extractQuotedNames(block, regex = /name:\s*"([^"]+)"/g) {
  const names = [];
  for (const match of block.matchAll(regex)) names.push(match[1]);
  return names;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function diff(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).sort();
}

const channelSource = fs.readFileSync(channelPath, "utf8");
const suiteClientSource = fs.readFileSync(suiteClientPath, "utf8");

const agentToolsBlock = extractBlock(channelSource, "agentTools: [", "\n\n  outbound:");
const registeredBlock = extractBlock(suiteClientSource, "const registered = [", "];\n      const available");

const channelToolNames = uniqueSorted(extractQuotedNames(agentToolsBlock));
const registeredToolNames = uniqueSorted(
  extractQuotedNames(registeredBlock, /"([^"]+)"/g),
);

const missingFromRegistered = diff(channelToolNames, registeredToolNames);
const extraInRegistered = diff(registeredToolNames, channelToolNames);
const missingLifecycle = diff(requiredLifecycleTools, channelToolNames);
const missingContextTools = diff(requiredContextTools, channelToolNames);

if (missingFromRegistered.length || extraInRegistered.length || missingLifecycle.length || missingContextTools.length) {
  console.error("Startup Suite plugin tool contract check failed.\n");

  if (missingFromRegistered.length) {
    console.error("Missing from suite-client registered list:");
    for (const name of missingFromRegistered) console.error(`  - ${name}`);
    console.error("");
  }

  if (extraInRegistered.length) {
    console.error("Extra entries in suite-client registered list:");
    for (const name of extraInRegistered) console.error(`  - ${name}`);
    console.error("");
  }

  if (missingLifecycle.length) {
    console.error("Missing required lifecycle tools from plugin agentTools:");
    for (const name of missingLifecycle) console.error(`  - ${name}`);
    console.error("");
  }

  if (missingContextTools.length) {
    console.error("Missing required context tools from plugin agentTools:");
    for (const name of missingContextTools) console.error(`  - ${name}`);
    console.error("");
  }

  process.exit(1);
}

console.log(
  `Startup Suite plugin tool contract OK: ${channelToolNames.length} tools, lifecycle + context aliases present, suite-client registry in sync.`,
);
