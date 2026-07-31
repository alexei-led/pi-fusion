import {
  PANEL_DECISION_CLOSE,
  PANEL_DECISION_OPEN,
} from "./run-observations.js";
import {
  THINKING_LEVELS,
  type FailedPanelSummary,
  type FusionProfile,
  type PanelMemberConfig,
  type PanelOutput,
  type ThinkingLevel,
} from "./types.js";

export const FUSION_ACCEPTANCE_DISABLED = {
  level: "none",
  reason:
    "pi-fusion panelists and judge are read-only advisory tasks; pi-fusion owns final synthesis and acceptance.",
} as const;

export type FusionAcceptanceDisabled = typeof FUSION_ACCEPTANCE_DISABLED;

export interface PanelSubagentTaskParams {
  agent: string;
  task: string;
  output: true;
  outputMode: "inline";
  progress: true;
  skill: false;
  acceptance: FusionAcceptanceDisabled;
  model?: string;
}

export interface PanelChainTaskParams extends PanelSubagentTaskParams {
  as: string;
  label: string;
  phase: "Panel";
}

export interface PanelSpawnParams {
  tasks: PanelSubagentTaskParams[];
  async: true;
  clarify: false;
  concurrency: number;
  context: "fresh" | "fork";
  output: true;
  outputMode: "inline";
  acceptance: FusionAcceptanceDisabled;
  timeoutMs?: number;
}

export interface FusionChainParallelStepParams {
  parallel: PanelChainTaskParams[];
  concurrency: number;
  failFast: false;
}

export interface FusionChainJudgeStepParams {
  agent: string;
  task: string;
  label: "Judge";
  phase: "Judge";
  output: true;
  outputMode: "inline";
  skill: false;
  acceptance: FusionAcceptanceDisabled;
  model?: string;
}

export interface FusionChainSpawnParams {
  chain: [FusionChainParallelStepParams, FusionChainJudgeStepParams];
  task: string;
  async: true;
  clarify: false;
  context: "fresh" | "fork";
  output: true;
  outputMode: "inline";
  acceptance: FusionAcceptanceDisabled;
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
  acceptance: FusionAcceptanceDisabled;
  model?: string;
  timeoutMs?: number;
}

export type { FailedPanelSummary, PanelOutput } from "./types.js";

export interface BuildJudgeSpawnParamsInput {
  profile: FusionProfile;
  prompt: string;
  panelOutputs: readonly PanelOutput[];
  failedPanelists: readonly FailedPanelSummary[];
  /**
   * Seeds the order panel answers are presented to the judge. Required rather
   * than optional: a missing seed would silently restore the fixed index order
   * and its position bias.
   */
  runId: string;
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
    tasks: profile.panel.map((member) =>
      buildPanelTaskParams(
        member,
        prompt,
        profile.stopWhenPanelAgrees === true,
      ),
    ),
    async: true,
    clarify: false,
    concurrency: profile.concurrency ?? profile.panel.length,
    context: profile.context ?? "fresh",
    output: true,
    outputMode: "inline",
    acceptance: FUSION_ACCEPTANCE_DISABLED,
    ...(profile.timeoutMs !== undefined
      ? { timeoutMs: profile.timeoutMs }
      : {}),
  };
}

export function buildFusionChainSpawnParams(
  profile: FusionProfile,
  prompt: string,
): FusionChainSpawnParams {
  const model = appendThinkingSuffix(
    profile.judge.model,
    profile.judge.thinking,
  );
  return {
    chain: [
      {
        parallel: profile.panel.map((member, index) =>
          buildPanelChainTaskParams(member, index),
        ),
        concurrency: profile.concurrency ?? profile.panel.length,
        failFast: false,
      },
      {
        agent: profile.judge.agent,
        task: buildChainJudgeTask(profile.panel),
        label: "Judge",
        phase: "Judge",
        output: true,
        outputMode: "inline",
        skill: false,
        acceptance: FUSION_ACCEPTANCE_DISABLED,
        ...(model ? { model } : {}),
      },
    ],
    task: prompt.trim(),
    async: true,
    clarify: false,
    context: profile.context ?? "fresh",
    output: true,
    outputMode: "inline",
    acceptance: FUSION_ACCEPTANCE_DISABLED,
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
    acceptance: FUSION_ACCEPTANCE_DISABLED,
    ...(model ? { model } : {}),
    ...(input.profile.timeoutMs !== undefined
      ? { timeoutMs: input.profile.timeoutMs }
      : {}),
  };
}

function buildPanelTaskParams(
  member: PanelMemberConfig,
  prompt: string,
  includeDecisionRecord: boolean,
): PanelSubagentTaskParams {
  const model = appendThinkingSuffix(member.model, member.thinking);
  return {
    agent: member.agent,
    task: buildPanelTask(member, prompt, includeDecisionRecord),
    output: true,
    outputMode: "inline",
    progress: true,
    skill: false,
    acceptance: FUSION_ACCEPTANCE_DISABLED,
    ...(model ? { model } : {}),
  };
}

function buildPanelChainTaskParams(
  member: PanelMemberConfig,
  index: number,
): PanelChainTaskParams {
  const model = appendThinkingSuffix(member.model, member.thinking);
  return {
    agent: member.agent,
    task: buildPanelTask(member, "{task}", false),
    as: chainOutputName(member, index),
    label: member.label,
    phase: "Panel",
    output: true,
    outputMode: "inline",
    progress: true,
    skill: false,
    acceptance: FUSION_ACCEPTANCE_DISABLED,
    ...(model ? { model } : {}),
  };
}

function buildPanelTask(
  member: PanelMemberConfig,
  prompt: string,
  includeDecisionRecord: boolean,
): string {
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
    "- Read-only: inspect only; leave files, git state, and the workspace untouched.",
    "- Do not ask other agents.",
    "- Do not run subagents.",
    "- Use local inspection only when code evidence is needed.",
    "- Be concise and cite evidence when you inspect files.",
    "",
    "Output contract:",
    ...PANEL_OUTPUT_CONTRACT,
    ...(includeDecisionRecord
      ? [
          "",
          "Decision record:",
          "- End with exactly one single-line JSON record wrapped in the tags below.",
          "- Keep the complete human-readable answer in the Markdown sections above the record.",
          "- recommendation: one short plain-language conclusion.",
          "- confidence: low, medium, or high.",
          "- needsMoreEvidence: true when the answer should not be trusted without more investigation.",
          `- Format: ${PANEL_DECISION_OPEN}{"recommendation":"...","confidence":"high","needsMoreEvidence":false}${PANEL_DECISION_CLOSE}`,
          "- Do not add Markdown or any other text after the record.",
        ]
      : []),
  ].join("\n");
}

function buildJudgeTask(input: BuildJudgeSpawnParamsInput): string {
  const sortedOutputs = [...input.panelOutputs].sort(comparePanelItems);
  const sortedFailures = [...input.failedPanelists].sort(comparePanelItems);
  // Status and failure lists stay in configuration order so the reader can map
  // them to the profile. Only the answers the judge weighs are shuffled.
  const presentedOutputs = shufflePanelItems(sortedOutputs, input.runId);
  return [
    "You are the fusion judge.",
    "Read-only synthesis only. Leave files, git state, and the workspace untouched. Do not ask other agents. Do not run subagents.",
    "Synthesize the panel results. Preserve disagreement instead of forcing consensus.",
    "",
    "Original task:",
    input.prompt.trim(),
    "",
    "Panel status:",
    ...formatPanelStatus(sortedOutputs, sortedFailures),
    "",
    "Successful panel outputs:",
    ...formatPanelOutputs(presentedOutputs),
    "",
    "Failed panelists:",
    ...formatFailedPanelists(sortedFailures),
    "",
    "Output contract:",
    ...JUDGE_OUTPUT_CONTRACT,
  ].join("\n");
}

function buildChainJudgeTask(panel: readonly PanelMemberConfig[]): string {
  return [
    "You are the fusion judge.",
    "Read-only synthesis only. Leave files, git state, and the workspace untouched. Do not ask other agents. Do not run subagents.",
    "Synthesize the panel results. Preserve disagreement instead of forcing consensus.",
    "",
    "Original task:",
    "{task}",
    "",
    "All listed panelists completed successfully.",
    "",
    "Panel outputs:",
    ...panel.flatMap((member, index) => [
      `## ${member.label} (${member.id})`,
      `Agent: ${member.agent}`,
      "",
      `{outputs.${chainOutputName(member, index)}}`,
      "",
    ]),
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

/**
 * LLM judges favour whichever candidate is presented first or last. A fixed
 * order therefore advantages the same panel member on every run. Shuffling
 * removes the bias; seeding it from the run id keeps a persisted run rendering
 * identically when it is replayed through `fusion:rpc:v1` adopt.
 */
export function shufflePanelItems<T>(
  items: readonly T[],
  seed: string,
): T[] {
  const shuffled = [...items];
  const nextRandom = createSeededRandom(seed);
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(nextRandom() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
  }
  return shuffled;
}

function createSeededRandom(seed: string): () => number {
  // FNV-1a over the seed, then mulberry32. Small, dependency-free, and stable
  // across Node versions - the reproducibility guarantee depends on that.
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "unknown failure";
}

function chainOutputName(member: PanelMemberConfig, index: number): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(member.id)
    ? member.id
    : `panel_${index + 1}`;
}

function hasThinkingSuffix(model: string): boolean {
  const colonIndex = model.lastIndexOf(":");
  if (colonIndex === -1) return false;
  const suffix = model.slice(colonIndex + 1);
  return (THINKING_LEVELS as readonly string[]).includes(suffix);
}
