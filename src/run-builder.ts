import {
  callerOutputContractInstructions,
  detectCallerOutputContract,
} from "./caller-contract.js";
import {
  PANEL_DECISION_CLOSE,
  PANEL_DECISION_OPEN,
} from "./run-observations.js";
import {
  COMPOSER_AGENT,
  JUDGE_AGENT,
  memberLabel,
  panelItemLabel,
  resolveSynthesisMode,
  type CallerOutputContract,
  THINKING_LEVELS,
  type FailedPanelSummary,
  type FusionProfile,
  type PanelMemberConfig,
  type PanelOutput,
  type ThinkingLevel,
  type ToolBudget,
} from "./types.js";

export const FUSION_ACCEPTANCE_DISABLED = {
  level: "none",
  reason:
    "pi-fusion panelists and judge are read-only advisory tasks; pi-fusion owns final synthesis and acceptance.",
} as const;

export type FusionAcceptanceDisabled = typeof FUSION_ACCEPTANCE_DISABLED;

const DEFAULT_STAGE_TIMEOUT_MS = 900_000;
const DEFAULT_TOOL_BUDGET: ToolBudget = {
  soft: 8,
  hard: 12,
  block: "*",
};

export interface PanelSubagentTaskParams {
  agent: string;
  task: string;
  output: true;
  outputMode: "inline";
  progress: true;
  skill: false;
  acceptance: FusionAcceptanceDisabled;
  model?: string;
  /** Per-task cap so a panelist finalises before the workflow timeout. */
  toolBudget: ToolBudget;
}

export interface PanelWorkflowTaskParams extends PanelSubagentTaskParams {
  key: string;
}

export interface PanelSpawnParams {
  workflowScript: string;
  async: true;
  context: "fresh" | "fork";
  output: true;
  outputMode: "inline";
  acceptance: FusionAcceptanceDisabled;
  timeoutMs?: number;
}

export interface JudgeWorkflowTaskParams {
  agent: string;
  task: string;
  output: true;
  outputMode: "inline";
  skill: false;
  acceptance: FusionAcceptanceDisabled;
  model?: string;
  /** Per-task cap on judge tool calls; see `FusionProfile.judgeToolBudget`. */
  toolBudget?: ToolBudget;
}

export interface JudgeSpawnParams {
  workflowScript: string;
  async: true;
  context: "fresh" | "fork";
  output: true;
  outputMode: "inline";
  acceptance: FusionAcceptanceDisabled;
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
  callerContract?: CallerOutputContract;
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
  "## Contested Claims",
  "## Unique Insights",
  "## Blind Spots",
  "## Recommendation",
  "## Risks",
  "## Next Step",
] as const;

const COMPOSER_OUTPUT_CONTRACT = [
  "# Fusion Report",
  "## Summary",
  "## Coverage Map",
  "## Combined Answer",
  "## Gaps",
  "## Conflicts At Seams",
  "## Agent Status",
  "## Risks",
  "## Next Step",
] as const;

const COMPOSER_INSTRUCTIONS = [
  "You are the fusion composer.",
  "Read-only synthesis only. Leave files, git state, and the workspace untouched. Do not ask other agents. Do not run subagents.",
  "The panelists answered DIFFERENT facets of one task. Merge their answers; do not pick a winner.",
  "- Do not rank panelists. They were not competing.",
  "- Report a conflict only where facets genuinely overlap and disagree. Different subject matter is not disagreement.",
  "- Name facets nobody covered, or covered only in passing.",
  "- Where facets overlap and state conflicting facts about this codebase, check the claim with your read tools and cite file:line under Conflicts At Seams. Do not settle it by whose wording sounds more confident.",
] as const;

const CONTESTED_CLAIMS_INSTRUCTIONS = [
  "Contested claims:",
  "- Where panelists state conflicting facts about this codebase, do not pick the more confident wording.",
  "- Check the claim yourself with your read tools and cite file:line.",
  "- Report each contested claim as: the claim, what you found, and which panelist was right.",
  "- If you could not verify a claim, say so explicitly rather than choosing.",
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
  callerContract?: CallerOutputContract,
): PanelSpawnParams {
  const concurrency = profile.concurrency ?? profile.panel.length;
  const tasks: PanelWorkflowTaskParams[] = profile.panel.map(
    (member, index) => ({
      key: `panel-${index + 1}`,
      ...buildPanelTaskParams(
        member,
        prompt,
        profile.stopWhenPanelAgrees === true,
        profile.panelToolBudget ?? DEFAULT_TOOL_BUDGET,
        callerContract,
      ),
    }),
  );

  return {
    workflowScript: buildPanelWorkflowScript(
      tasks,
      concurrency,
      profile.stopWhenPanelAgrees === true,
    ),
    async: true,
    context: profile.context ?? "fresh",
    output: true,
    outputMode: "inline",
    acceptance: FUSION_ACCEPTANCE_DISABLED,
    timeoutMs: resolveStageTimeout(profile.panelTimeoutMs, profile.timeoutMs),
  };
}

export function buildJudgeSpawnParams(
  input: BuildJudgeSpawnParamsInput,
): JudgeSpawnParams {
  const model = appendThinkingSuffix(
    input.profile.judge.model,
    input.profile.judge.thinking,
  );
  const task: JudgeWorkflowTaskParams = {
    agent: resolveSynthesisAgent(input.profile),
    task: buildJudgeTask(input),
    output: true,
    outputMode: "inline",
    skill: false,
    acceptance: FUSION_ACCEPTANCE_DISABLED,
    ...(model ? { model } : {}),
    toolBudget: input.profile.judgeToolBudget ?? DEFAULT_TOOL_BUDGET,
  };

  return {
    workflowScript: `return runs.run("judge", ${JSON.stringify(task)});`,
    async: true,
    context: input.profile.context ?? "fresh",
    output: true,
    outputMode: "inline",
    acceptance: FUSION_ACCEPTANCE_DISABLED,
    timeoutMs: resolveStageTimeout(
      input.profile.judgeTimeoutMs,
      input.profile.timeoutMs,
    ),
  };
}

function buildPanelWorkflowScript(
  tasks: readonly PanelWorkflowTaskParams[],
  concurrency: number,
  stopWhenAgrees: boolean,
): string {
  const serializedTasks = JSON.stringify(tasks);
  const effectiveConcurrency = stopWhenAgrees
    ? Math.min(concurrency, 2)
    : concurrency;
  const stopLogic = stopWhenAgrees
    ? [
        "const decisions = results",
        "  .filter((result) => result && result.ok === true)",
        "  .map((result) => {",
        "    const text = typeof result.output === \"string\" ? result.output : \"\";",
        "    const match = text.match(/<fusion-panel-decision>([\\s\\S]*?)<\\/fusion-panel-decision>\\s*$/);",
        "    if (!match) return undefined;",
        "    try { return JSON.parse(match[1]); } catch { return undefined; }",
        "  })",
        "  .filter((decision) => decision && typeof decision.recommendation === \"string\" && decision.confidence === \"high\" && decision.needsMoreEvidence === false);",
        "if (decisions.length >= 2 && results.length < tasks.length) {",
        "  const recommendation = decisions[0].recommendation.trim().toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, \" \" ).trim(),",
        "    agrees = recommendation && decisions.every((decision) => decision.recommendation.trim().toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, \" \" ).trim() === recommendation);",
        "  if (agrees) {",
        "    emit({ type: \"pi-fusion-panel-stop\", indices: tasks.slice(results.length).map((_, index) => results.length + index) });",
        "    return results;",
        "  }",
        "}",
      ].join("\n")
    : "";

  return [
    `const tasks = ${serializedTasks};`,
    `const concurrency = ${effectiveConcurrency};`,
    "const results = [];",
    "for (let index = 0; index < tasks.length; index += concurrency) {",
    "  results.push(...await runs.all(tasks.slice(index, index + concurrency)));",
    stopWhenAgrees ? "  " + stopLogic.replaceAll("\n", "\n  ") : "",
    "}",
    "return results;",
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveStageTimeout(
  stageTimeoutMs: number | undefined,
  legacyTimeoutMs: number | undefined,
): number {
  return stageTimeoutMs ?? legacyTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
}

function buildPanelTaskParams(
  member: PanelMemberConfig,
  prompt: string,
  includeDecisionRecord: boolean,
  toolBudget: ToolBudget,
  callerContract?: CallerOutputContract,
): PanelSubagentTaskParams {
  const model = appendThinkingSuffix(member.model, member.thinking);
  return {
    agent: member.agent,
    task: buildPanelTask(
      member,
      prompt,
      includeDecisionRecord,
      callerContract,
    ),
    output: true,
    outputMode: "inline",
    progress: true,
    skill: false,
    acceptance: FUSION_ACCEPTANCE_DISABLED,
    toolBudget,
    ...(model ? { model } : {}),
  };
}

export function buildPanelTask(
  member: PanelMemberConfig,
  prompt: string,
  includeDecisionRecord: boolean,
  callerContractOverride?: CallerOutputContract,
): string {
  const role = member.role?.trim() || "independent analysis and critique";
  const callerContract =
    callerContractForPrompt(prompt, callerContractOverride);
  return [
    `Panel member: ${memberLabel(member)} (${member.id})`,
    `Role: ${role}`,
    "",
    ...formatMemberTask(member, prompt),
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
    ...(callerContract
      ? callerOutputContractInstructions(callerContract)
      : PANEL_OUTPUT_CONTRACT),
    ...(includeDecisionRecord && !callerContract
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

/**
 * Merge mode swaps the synthesis agent, not the run slot. It still spawns into
 * `judgeRunId`/`judgeAsyncDir` under phase `judge`, so `fusion:rpc:v1` consumers
 * see no new phase value.
 *
 * An explicitly configured judge agent still wins: a user who names their own
 * synthesis agent means it.
 */
export function resolveSynthesisAgent(profile: FusionProfile): string {
  if (resolveSynthesisMode(profile) !== "merge") return profile.judge.agent;
  return profile.judge.agent === JUDGE_AGENT
    ? COMPOSER_AGENT
    : profile.judge.agent;
}

const TASK_PLACEHOLDER = "{task}";

/**
 * A member with a `question` answers that facet instead of the whole prompt.
 * If the template omits `{task}` the original prompt is still appended: dropping
 * it would silently strip the context the panelist needs.
 */
function formatMemberTask(member: PanelMemberConfig, prompt: string): string[] {
  const question = member.question?.trim();
  const task = prompt.trim();
  if (!question) return ["Original task:", task];

  const facet = question.replaceAll(TASK_PLACEHOLDER, task);
  if (question.includes(TASK_PLACEHOLDER)) {
    return ["Your assigned facet of the task:", facet];
  }
  return [
    "Your assigned facet of the task:",
    facet,
    "",
    "Original task:",
    task,
  ];
}

function callerContractForPrompt(
  prompt: string,
  explicit?: CallerOutputContract,
): CallerOutputContract | undefined {
  return explicit ?? detectCallerOutputContract(prompt);
}

export function buildJudgeTask(input: BuildJudgeSpawnParamsInput): string {
  const sortedOutputs = [...input.panelOutputs].sort(comparePanelItems);
  const sortedFailures = [...input.failedPanelists].sort(comparePanelItems);
  // Status and failure lists stay in configuration order so the reader can map
  // them to the profile. Only the answers the judge weighs are shuffled.
  const presentedOutputs = shufflePanelItems(sortedOutputs, input.runId);
  const blindLabels = input.profile.blindPanelLabels
    ? buildBlindLabelMap([...sortedOutputs, ...sortedFailures])
    : undefined;
  const merging = resolveSynthesisMode(input.profile) === "merge";
  const callerContract = callerContractForPrompt(
    input.prompt,
    input.callerContract,
  );
  return [
    ...(merging
      ? COMPOSER_INSTRUCTIONS
      : [
          "You are the fusion judge.",
          "Read-only synthesis only. Leave files, git state, and the workspace untouched. Do not ask other agents. Do not run subagents.",
          "Synthesize the panel results. Preserve disagreement instead of forcing consensus.",
        ]),
    "",
    "Original task:",
    input.prompt.trim(),
    "",
    "Panel status:",
    ...formatPanelStatus(sortedOutputs, sortedFailures, blindLabels),
    "",
    ...(merging
      ? [
          "Facet assignments:",
          ...formatFacetAssignments(input.profile, input.prompt, blindLabels),
          "",
        ]
      : []),
    "Successful panel outputs:",
    ...formatPanelOutputs(presentedOutputs, blindLabels),
    "",
    "Failed panelists:",
    ...formatFailedPanelists(sortedFailures, blindLabels),
    "",
    // Judge-only. The composer has no Contested Claims section, so this block
    // produces content the report silently drops, and its "which panelist was
    // right" wording contradicts the composer's "do not rank panelists".
    ...(merging ? [] : [...CONTESTED_CLAIMS_INSTRUCTIONS, ""]),
    "Output contract:",
    ...(callerContract
      ? callerOutputContractInstructions(callerContract)
      : merging
        ? COMPOSER_OUTPUT_CONTRACT
        : JUDGE_OUTPUT_CONTRACT),
  ].join("\n");
}

/**
 * Lists what each member was asked to cover, so the composer can name gaps
 * without reverse-engineering them from the answers it did receive.
 */
function formatFacetAssignments(
  profile: FusionProfile,
  prompt: string,
  blindLabels?: ReadonlyMap<number, string>,
): string[] {
  return profile.panel.map((member, index) => {
    // Substituted the same way the panelist saw it; the raw template would put
    // a literal "{task}" in front of the composer.
    const question = member.question?.trim();
    const facet = question
      ? question.replaceAll(TASK_PLACEHOLDER, prompt.trim())
      : (member.role?.trim() ?? "the whole task");
    // The blind map only covers members that produced an output or a failure.
    // A member stopped early by `stopWhenPanelAgrees` is in neither, and
    // falling back to `member.label` would leak the name into the very prompt
    // that is meant to hide it.
    const name = blindLabels
      ? (blindLabels.get(index) ?? "Candidate (did not report)")
      : memberLabel(member);
    return `- ${name}: ${facet}`;
  });
}

function formatPanelStatus(
  outputs: readonly PanelOutput[],
  failures: readonly FailedPanelSummary[],
  blindLabels?: ReadonlyMap<number, string>,
): string[] {
  const lines = [
    `- Successful panelists: ${outputs.length}`,
    `- Failed panelists: ${failures.length}`,
  ];
  for (const output of outputs) {
    lines.push(`- ${formatPanelName(output, blindLabels)}: succeeded`);
  }
  for (const failure of failures) {
    lines.push(
      `- ${formatPanelName(failure, blindLabels)}: failed - ${firstLine(failure.summary)}`,
    );
  }
  return lines;
}

function formatPanelOutputs(
  outputs: readonly PanelOutput[],
  blindLabels?: ReadonlyMap<number, string>,
): string[] {
  if (outputs.length === 0) return ["(none)"];
  // Agent names and artifact paths carry the member id, so they are withheld
  // when blinding. They are debugging aids for the reader, not judging inputs.
  return outputs.flatMap((output) => [
    `## ${formatPanelName(output, blindLabels)}`,
    ...(blindLabels
      ? []
      : [
          `Agent: ${output.agent}`,
          ...(output.artifactPath ? [`Artifact: ${output.artifactPath}`] : []),
          ...(output.sessionPath ? [`Session: ${output.sessionPath}`] : []),
        ]),
    "",
    output.output,
    "",
  ]);
}

function formatFailedPanelists(
  failures: readonly FailedPanelSummary[],
  blindLabels?: ReadonlyMap<number, string>,
): string[] {
  if (failures.length === 0) return ["(none)"];
  return failures.flatMap((failure) =>
    blindLabels
      ? [`- ${formatPanelName(failure, blindLabels)}: ${failure.summary}`]
      : [
          `- ${formatPanelName(failure)} (${failure.agent}): ${failure.summary}`,
          ...(failure.artifactPath
            ? [`  Artifact: ${failure.artifactPath}`]
            : []),
          ...(failure.sessionPath ? [`  Session: ${failure.sessionPath}`] : []),
        ],
  );
}

function formatPanelName(
  item: Pick<PanelOutput, "index" | "id" | "label">,
  blindLabels?: ReadonlyMap<number, string>,
): string {
  return blindLabels?.get(item.index) ?? panelItemLabel(item);
}

/**
 * Maps panel indices to neutral "Candidate X" names. Assigned by index rather
 * than presentation order so the mapping is stable and the report can restore
 * real names without persisting extra run state.
 */
export function buildBlindLabelMap(
  items: readonly Pick<PanelOutput, "index">[],
): Map<number, string> {
  const labels = new Map<number, string>();
  const indices = [...new Set(items.map((item) => item.index))].sort(
    (left, right) => left - right,
  );
  indices.forEach((index, position) => {
    labels.set(index, `Candidate ${blindLabelFor(position)}`);
  });
  return labels;
}

function blindLabelFor(position: number): string {
  // A..Z, then AA, AB, ... for panels larger than the alphabet.
  let remaining = position;
  let label = "";
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
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
export function shufflePanelItems<T>(items: readonly T[], seed: string): T[] {
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

function hasThinkingSuffix(model: string): boolean {
  const colonIndex = model.lastIndexOf(":");
  if (colonIndex === -1) return false;
  const suffix = model.slice(colonIndex + 1);
  return (THINKING_LEVELS as readonly string[]).includes(suffix);
}
