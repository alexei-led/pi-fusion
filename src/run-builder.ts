import {
  THINKING_LEVELS,
  type FusionProfile,
  type PanelMemberConfig,
  type ThinkingLevel,
} from "./types.js";

export interface PanelSubagentTaskParams {
  agent: string;
  task: string;
  output: true;
  outputMode: "inline";
  progress: true;
  skill: false;
  acceptance: "none";
  model?: string;
}

export interface PanelSpawnParams {
  tasks: PanelSubagentTaskParams[];
  async: true;
  clarify: false;
  concurrency: number;
  context: "fresh" | "fork";
  output: true;
  outputMode: "inline";
  timeoutMs?: number;
}

export interface JudgeSpawnParams {
  agent: string;
  task: string;
  async: true;
  clarify: false;
  context: "fresh" | "fork";
  output: true;
  outputMode: "inline";
  skill: false;
  acceptance: "none";
  model?: string;
  timeoutMs?: number;
}

export interface PanelOutput {
  index: number;
  agent: string;
  output: string;
  id?: string;
  label?: string;
  artifactPath?: string;
  sessionPath?: string;
}

export interface FailedPanelSummary {
  index: number;
  agent: string;
  summary: string;
  id?: string;
  label?: string;
  artifactPath?: string;
  sessionPath?: string;
}

export interface BuildJudgeSpawnParamsInput {
  profile: FusionProfile;
  prompt: string;
  panelOutputs: readonly PanelOutput[];
  failedPanelists: readonly FailedPanelSummary[];
}

const PANEL_OUTPUT_CONTRACT = [
  "## Summary",
  "## Recommendation",
  "## Evidence",
  "## Risks",
  "## Confidence",
  "## Open Questions",
] as const;

const JUDGE_OUTPUT_CONTRACT = [
  "# Fusion Report",
  "## Summary",
  "## Agent Status",
  "## Consensus",
  "## Disagreements",
  "## Unique Insights",
  "## Blind Spots",
  "## Recommendation",
  "## Risks",
  "## Next Step",
] as const;

export function appendThinkingSuffix(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
): string | undefined {
  if (!model || !thinking) return model;
  if (hasThinkingSuffix(model)) return model;
  return `${model}:${thinking}`;
}

export function buildPanelSpawnParams(
  profile: FusionProfile,
  prompt: string,
): PanelSpawnParams {
  return {
    tasks: profile.panel.map((member) => buildPanelTaskParams(member, prompt)),
    async: true,
    clarify: false,
    concurrency: profile.concurrency ?? profile.panel.length,
    context: profile.context ?? "fresh",
    output: true,
    outputMode: "inline",
    ...(profile.timeoutMs !== undefined
      ? { timeoutMs: profile.timeoutMs }
      : {}),
  };
}

export function buildJudgeSpawnParams(
  input: BuildJudgeSpawnParamsInput,
): JudgeSpawnParams {
  const model = appendThinkingSuffix(
    input.profile.judge.model,
    input.profile.judge.thinking,
  );
  return {
    agent: input.profile.judge.agent,
    task: buildJudgeTask(input),
    async: true,
    clarify: false,
    context: input.profile.context ?? "fresh",
    output: true,
    outputMode: "inline",
    skill: false,
    acceptance: "none",
    ...(model ? { model } : {}),
    ...(input.profile.timeoutMs !== undefined
      ? { timeoutMs: input.profile.timeoutMs }
      : {}),
  };
}

function buildPanelTaskParams(
  member: PanelMemberConfig,
  prompt: string,
): PanelSubagentTaskParams {
  const model = appendThinkingSuffix(member.model, member.thinking);
  return {
    agent: member.agent,
    task: buildPanelTask(member, prompt),
    output: true,
    outputMode: "inline",
    progress: true,
    skill: false,
    acceptance: "none",
    ...(model ? { model } : {}),
  };
}

function buildPanelTask(member: PanelMemberConfig, prompt: string): string {
  const role = member.role?.trim() || "independent analysis and critique";
  return [
    `Panel member: ${member.label} (${member.id})`,
    `Role: ${role}`,
    "",
    "Original task:",
    prompt.trim(),
    "",
    "Instructions:",
    "- Work independently from the other panelists.",
    "- Do not edit files, stage changes, commit changes, or run destructive commands.",
    "- Do not ask other agents and do not run subagents.",
    "- Use read-only local inspection only when code evidence is needed.",
    "- Be concise and cite evidence when you inspect files.",
    "",
    "Output contract:",
    ...PANEL_OUTPUT_CONTRACT,
  ].join("\n");
}

function buildJudgeTask(input: BuildJudgeSpawnParamsInput): string {
  const sortedOutputs = [...input.panelOutputs].sort(comparePanelItems);
  const sortedFailures = [...input.failedPanelists].sort(comparePanelItems);
  return [
    "You are the fusion judge.",
    "Do not edit files. Do not ask other agents. Do not run subagents.",
    "Synthesize the panel results. Preserve disagreement instead of forcing consensus.",
    "",
    "Original task:",
    input.prompt.trim(),
    "",
    "Panel status:",
    ...formatPanelStatus(sortedOutputs, sortedFailures),
    "",
    "Successful panel outputs:",
    ...formatPanelOutputs(sortedOutputs),
    "",
    "Failed panelists:",
    ...formatFailedPanelists(sortedFailures),
    "",
    "Output contract:",
    ...JUDGE_OUTPUT_CONTRACT,
  ].join("\n");
}

function formatPanelStatus(
  outputs: readonly PanelOutput[],
  failures: readonly FailedPanelSummary[],
): string[] {
  const lines = [
    `- Successful panelists: ${outputs.length}`,
    `- Failed panelists: ${failures.length}`,
  ];
  for (const output of outputs) {
    lines.push(`- ${formatPanelName(output)}: succeeded`);
  }
  for (const failure of failures) {
    lines.push(
      `- ${formatPanelName(failure)}: failed - ${firstLine(failure.summary)}`,
    );
  }
  return lines;
}

function formatPanelOutputs(outputs: readonly PanelOutput[]): string[] {
  if (outputs.length === 0) return ["(none)"];
  return outputs.flatMap((output) => [
    `## ${formatPanelName(output)}`,
    `Agent: ${output.agent}`,
    ...(output.artifactPath ? [`Artifact: ${output.artifactPath}`] : []),
    ...(output.sessionPath ? [`Session: ${output.sessionPath}`] : []),
    "",
    output.output,
    "",
  ]);
}

function formatFailedPanelists(
  failures: readonly FailedPanelSummary[],
): string[] {
  if (failures.length === 0) return ["(none)"];
  return failures.flatMap((failure) => [
    `- ${formatPanelName(failure)} (${failure.agent}): ${failure.summary}`,
    ...(failure.artifactPath ? [`  Artifact: ${failure.artifactPath}`] : []),
    ...(failure.sessionPath ? [`  Session: ${failure.sessionPath}`] : []),
  ]);
}

function formatPanelName(
  item: Pick<PanelOutput, "index" | "id" | "label">,
): string {
  return item.label ?? item.id ?? `Panelist ${item.index + 1}`;
}

function comparePanelItems(
  left: Pick<PanelOutput, "index">,
  right: Pick<PanelOutput, "index">,
): number {
  return left.index - right.index;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "unknown failure";
}

function hasThinkingSuffix(model: string): boolean {
  const colonIndex = model.lastIndexOf(":");
  if (colonIndex === -1) return false;
  const suffix = model.slice(colonIndex + 1);
  return (THINKING_LEVELS as readonly string[]).includes(suffix);
}
