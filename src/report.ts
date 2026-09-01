import {
  detectCallerOutputContract,
  validateCallerOutput,
} from "./caller-contract.js";
import {
  buildBlindLabelMap,
  type FailedPanelSummary,
  type PanelOutput,
} from "./run-builder.js";
import { summarizeProviderFailures } from "./run-observations.js";
import {
  memberLabel,
  panelItemLabel,
  type FusionRun,
  type FusionSynthesisMode,
  type PanelMemberConfig,
  type ProviderFailure,
  type RunObservation,
} from "./types.js";

type ReportRun = Pick<
  FusionRun,
  | "id"
  | "prompt"
  | "profileName"
  | "chainRunId"
  | "panelRunId"
  | "judgeRunId"
  | "panelStopReason"
  | "outputContract"
  | "completionQuality"
  | "minimumSuccessfulPanelists"
  | "effectiveTimeouts"
> &
  Partial<Pick<FusionRun, "phase" | "createdAt" | "updatedAt">>;

export interface RenderPanelFailureReportInput {
  run: ReportRun;
  failures: readonly FailedPanelSummary[];
  error?: string;
  judgeModel?: string;
  synthesis?: FusionSynthesisMode;
  /** Configured members, so a merge failure can name the uncovered facets. */
  panel?: readonly PanelMemberConfig[];
}

export interface RenderSinglePanelReportInput {
  run: ReportRun;
  output: PanelOutput;
  failures: readonly FailedPanelSummary[];
  judgeModel?: string;
}

export interface RenderPartialPanelReportInput {
  run: ReportRun;
  panelOutputs: readonly PanelOutput[];
  failures: readonly FailedPanelSummary[];
  required: number;
  synthesis: FusionSynthesisMode;
  panel: readonly PanelMemberConfig[];
  judgeModel?: string;
}

export interface RenderJudgeReportInput {
  run: ReportRun;
  judgeOutput: string;
  panelOutputs?: readonly PanelOutput[];
  failures?: readonly FailedPanelSummary[];
  judgeModel?: string;
  judgeObservation?: RunObservation;
  /**
   * Set when the judge was shown neutral candidate names. The report always
   * shows real member names, so the judge's prose is rewritten before parsing.
   */
  blindPanelLabels?: boolean;
  /** Selects which synthesis sections the report renders. Defaults to `select`. */
  synthesis?: FusionSynthesisMode;
}

export interface RenderFailureReportInput {
  synthesis?: FusionSynthesisMode;
  /** Configured members, so a merge failure can name the uncovered facets. */
  panel?: readonly PanelMemberConfig[];
  run: ReportRun;
  error: string;
  panelOutputs?: readonly PanelOutput[];
  failures?: readonly FailedPanelSummary[];
  judgeModel?: string;
}

export interface RenderCancelledReportInput {
  synthesis?: FusionSynthesisMode;
  /** Configured members, so a merge failure can name the uncovered facets. */
  panel?: readonly PanelMemberConfig[];
  run: ReportRun;
  method: "stop" | "interrupt" | "local";
  targetRunId?: string;
  panelOutputs?: readonly PanelOutput[];
  failures?: readonly FailedPanelSummary[];
  judgeModel?: string;
}

type ReportSectionTitle =
  | "Summary"
  | "Agent Status"
  | "Consensus"
  | "Disagreements"
  | "Contested Claims"
  | "Unique Insights"
  | "Blind Spots"
  | "Coverage Map"
  | "Combined Answer"
  | "Gaps"
  | "Conflicts At Seams"
  | "Recommendation"
  | "Risks"
  | "Next Step"
  | "Run Details"
  | "Run Metadata";

interface ReportSection {
  title: ReportSectionTitle;
  content: string | readonly string[];
}

interface AgentStatusOptions {
  panelOutputs?: readonly PanelOutput[];
  failures?: readonly FailedPanelSummary[];
  judgeStatus: string;
  judgeModel?: string;
  extra?: readonly string[];
  /** Names the synthesis step for the reader. Merge runs the composer. */
  synthesis?: FusionSynthesisMode;
}

/** Lists the facets that no panelist covered, for a merge-mode failure. */
function formatUncoveredFacets(
  panel?: readonly PanelMemberConfig[],
  outputs: readonly PanelOutput[] = [],
): string | string[] {
  if (!panel?.length) return "Every configured facet is uncovered.";
  const covered = new Set(outputs.map((output) => output.index));
  const missing = panel.filter((_member, index) => !covered.has(index));
  if (missing.length === 0) return "No configured facets are uncovered.";
  return missing.map((member) => {
    const facet =
      member.question?.trim() ?? member.role?.trim() ?? "the whole task";
    return `- ${memberLabel(member)}: ${facet} (uncovered)`;
  });
}

/**
 * The synthesis-shaped sections for a report that has no synthesis output:
 * failure, cancellation, or an all-failed panel. Select and merge need
 * different section names, so every such renderer goes through here rather than
 * hardcoding one shape.
 */
function emptySynthesisSections(input: {
  synthesis?: FusionSynthesisMode;
  reason: string;
  /** Select-mode wording, passed verbatim so each caller keeps its own text. */
  select: {
    consensus: string;
    disagreements: string;
    uniqueInsights: string;
    blindSpots: string;
  };
  panel?: readonly PanelMemberConfig[];
}): ReportSection[] {
  if (input.synthesis === "merge") {
    return [
      {
        title: "Coverage Map",
        content: `Nothing was covered because ${input.reason}.`,
      },
      { title: "Combined Answer", content: "No answer is available." },
      { title: "Gaps", content: formatUncoveredFacets(input.panel) },
      {
        title: "Conflicts At Seams",
        content: "No answers were produced, so no seams could conflict.",
      },
    ];
  }
  return [
    { title: "Consensus", content: input.select.consensus },
    { title: "Disagreements", content: input.select.disagreements },
    { title: "Unique Insights", content: input.select.uniqueInsights },
    { title: "Blind Spots", content: input.select.blindSpots },
  ];
}

/** What actually ran in the synthesis slot, for report labels. */
function synthesisLabel(synthesis?: FusionSynthesisMode): string {
  return synthesis === "merge" ? "Composer" : "Judge";
}

export function renderPanelFailureReport(
  input: RenderPanelFailureReportInput,
): string {
  const synthesisName = synthesisLabel(input.synthesis);
  // Under merge the select sections are meaningless: nobody answered the same
  // question, so there is no consensus to be absent. What the reader needs is
  // which facets went uncovered.
  const emptySections = emptySynthesisSections({
    ...(input.synthesis ? { synthesis: input.synthesis } : {}),
    reason: "all panelists failed",
    select: {
      consensus: "No consensus was available because all panelists failed.",
      disagreements: `No disagreements were synthesized because the ${synthesisName.toLowerCase()} did not run.`,
      uniqueInsights: "No panel output was available to summarize.",
      blindSpots:
        "All panelists failed, so the report may be missing every intended review perspective.",
    },
    ...(input.panel ? { panel: input.panel } : {}),
  });
  return renderReport([
    {
      title: "Summary",
      content:
        "No panelists completed successfully. The fusion run could not produce a recommendation.",
    },
    {
      title: "Agent Status",
      content: formatAgentStatus({
        panelOutputs: [],
        failures: input.failures,
        judgeStatus: "not run - no successful panelists",
        ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
        ...(input.synthesis ? { synthesis: input.synthesis } : {}),
      }),
    },
    ...emptySections,
    { title: "Recommendation", content: "No recommendation is available." },
    {
      title: "Risks",
      content: input.error
        ? `All panelists failed. Root error: ${firstLine(input.error)}`
        : "All panelists failed before producing usable output.",
    },
    {
      title: "Next Step",
      content:
        "Inspect the failed subagent run IDs or artifacts, then retry /fusion after fixing the cause.",
    },
    { title: "Run Metadata", content: formatRunMetadata(input.run) },
  ]);
}

export function renderSinglePanelReport(
  input: RenderSinglePanelReportInput,
): string {
  const exactOutput = validExactCallerOutput(input.run, input.output.output);
  if (exactOutput) return exactOutput;

  const panelName = formatPanelName(input.output);
  const sections: ReportSection[] = [
    {
      title: "Summary",
      content:
        "Only one panelist completed successfully, so pi-fusion skipped the judge step.",
    },
    {
      title: "Agent Status",
      content: formatAgentStatus({
        panelOutputs: [input.output],
        failures: input.failures,
        judgeStatus: "skipped - one successful panelist",
        ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
      }),
    },
    {
      title: "Consensus",
      content:
        "Only one panelist succeeded; no cross-panel consensus was available.",
    },
    {
      title: "Disagreements",
      content:
        "No disagreements were synthesized because the judge did not run.",
    },
    {
      title: "Unique Insights",
      content: `Single successful panelist: ${panelName}.`,
    },
    {
      title: "Blind Spots",
      content:
        "The result was not compared against another successful panelist or judge synthesis.",
    },
    {
      title: "Recommendation",
      content:
        input.output.output.trim() || "Panelist completed without output.",
    },
    {
      title: "Risks",
      content:
        "Single-panel results can miss disagreements, blind spots, and model-specific failure modes.",
    },
    {
      title: "Next Step",
      content:
        "Use this single-panel result directly, or rerun /fusion if you need judge synthesis.",
    },
    { title: "Run Metadata", content: formatRunMetadata(input.run) },
  ];
  const runDetails = formatRunDetails({
    panelOutputs: [input.output],
    failures: input.failures,
  });
  if (runDetails) sections.splice(-1, 0, runDetails);
  return renderReport(sections);
}

/**
 * Rewrites the neutral names the judge saw back to the configured member names.
 * Longest label first so "Candidate AA" is not partly replaced by "Candidate A".
 */
function validExactCallerOutput(
  run: ReportRun,
  output: string,
): string | undefined {
  const contract = run.outputContract ?? detectCallerOutputContract(run.prompt);
  if (!contract) return undefined;
  return validateCallerOutput(contract, output).ok ? output.trim() : undefined;
}

function restoreBlindLabels(
  judgeOutput: string,
  panelOutputs: readonly PanelOutput[],
  failures: readonly FailedPanelSummary[],
): string {
  const items = [...panelOutputs, ...failures];
  const blindLabels = buildBlindLabelMap(items);
  const realNames = new Map(
    items.map((item) => [item.index, panelItemLabel(item)]),
  );

  let restored = judgeOutput;
  const ordered = [...blindLabels.entries()].sort(
    (left, right) => right[1].length - left[1].length,
  );
  for (const [index, blindLabel] of ordered) {
    const realName = realNames.get(index);
    if (!realName) continue;
    restored = restored.replaceAll(blindLabel, realName);
  }
  return restored;
}

export function renderPartialPanelReport(
  input: RenderPartialPanelReportInput,
): string {
  const succeeded = input.panelOutputs.length;
  const merger = input.synthesis === "merge";
  const partial = `Partial panel coverage: ${succeeded} successful panelist(s), below the required quorum of ${input.required}. No ${merger ? "composer" : "judge"} synthesis was run.`;
  const candidateText = input.panelOutputs
    .map((output) => `### ${formatPanelName(output)}\n${output.output.trim()}`)
    .join("\n\n");
  const sections: ReportSection[] = [
    { title: "Summary", content: partial },
    {
      title: "Agent Status",
      content: formatAgentStatus({
        panelOutputs: input.panelOutputs,
        failures: input.failures,
        judgeStatus: `not run - below quorum (${succeeded}/${input.required})`,
        ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
        synthesis: input.synthesis,
        extra: ["- Completion quality: partial"],
      }),
    },
    ...(merger
      ? [
          { title: "Coverage Map" as const, content: "Partial coverage only; surviving facet outputs are listed below." },
          { title: "Combined Answer" as const, content: candidateText || "No usable panel output." },
          {
            title: "Gaps" as const,
            content: formatUncoveredFacets(input.panel, input.panelOutputs),
          },
          { title: "Conflicts At Seams" as const, content: "Not synthesized because the composer quorum was not met." },
        ]
      : [
          { title: "Consensus" as const, content: "Not synthesized because the panel quorum was not met." },
          { title: "Disagreements" as const, content: "Not synthesized because the judge did not run." },
          { title: "Unique Insights" as const, content: candidateText || "No usable panel output." },
          { title: "Blind Spots" as const, content: "Unavailable perspectives and absent cross-panel synthesis can hide important issues." },
        ]),
    { title: "Recommendation", content: "Use the surviving panel output as incomplete evidence, not a final fusion recommendation." },
    {
      title: "Risks",
      content: `Coverage is incomplete; ${input.failures.length} panelist(s) were unavailable${input.failures.some((failure) => failure.reason === "timeout") ? " (including timeout failures)" : ""}. Fusion did not retry any panelist.`,
    },
    { title: "Next Step", content: "Inspect the unavailable perspectives; after this terminal run, manually start a new /fusion run if full coverage is needed." },
    { title: "Run Metadata", content: formatRunMetadata(input.run) },
  ];
  const runDetails = formatRunDetails({
    panelOutputs: input.panelOutputs,
    failures: input.failures,
    ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
    synthesis: input.synthesis,
  });
  if (runDetails) sections.splice(-1, 0, runDetails);
  return renderReport(sections);
}

export function renderJudgeReport(input: RenderJudgeReportInput): string {
  const panelOutputs = input.panelOutputs ?? [];
  const failures = input.failures ?? [];
  const exactOutput = validExactCallerOutput(input.run, input.judgeOutput);
  if (exactOutput) return exactOutput;

  const judgeOutput = input.blindPanelLabels
    ? restoreBlindLabels(input.judgeOutput, panelOutputs, failures)
    : input.judgeOutput;
  const sections = parseMarkdownSections(judgeOutput);
  const unsectionedOutput = stripReportTitle(judgeOutput);
  const recommendationFallback =
    sections.size === 0 && unsectionedOutput
      ? unsectionedOutput
      : `${synthesisLabel(input.synthesis)} completed without a recommendation.`;

  // Section titles differ by synthesis mode; everything around them - agent
  // status, metadata, run details - is shared.
  const merging = input.synthesis === "merge";
  const synthesisSections: ReportSection[] = merging
    ? [
        {
          title: "Coverage Map",
          content:
            sections.get("Coverage Map") ?? "Not specified by the composer.",
        },
        {
          title: "Combined Answer",
          content:
            sections.get("Combined Answer") ?? "Not specified by the composer.",
        },
        {
          title: "Gaps",
          content: sections.get("Gaps") ?? "Not specified by the composer.",
        },
        {
          title: "Conflicts At Seams",
          content:
            sections.get("Conflicts At Seams") ??
            "Not specified by the composer.",
        },
      ]
    : [
        {
          title: "Consensus",
          content: sections.get("Consensus") ?? "Not specified by the judge.",
        },
        {
          title: "Disagreements",
          content:
            sections.get("Disagreements") ?? "Not specified by the judge.",
        },
        {
          title: "Contested Claims",
          content:
            sections.get("Contested Claims") ?? "Not specified by the judge.",
        },
        {
          title: "Unique Insights",
          content:
            sections.get("Unique Insights") ?? "Not specified by the judge.",
        },
        {
          title: "Blind Spots",
          content: sections.get("Blind Spots") ?? "Not specified by the judge.",
        },
      ];

  const reportSections: ReportSection[] = [
    {
      title: "Summary",
      content:
        input.run.completionQuality === "partial"
          ? `Partial panel coverage: ${panelOutputs.length} successful panelist(s) and ${failures.length} unavailable perspective(s) were synthesized. ${sections.get("Summary") ?? ""}`.trim()
          : (sections.get("Summary") ?? judgeSummary(panelOutputs, failures)),
    },
    {
      title: "Agent Status",
      content: formatAgentStatus({
        panelOutputs,
        failures,
        judgeStatus: "succeeded",
        ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
        ...(input.synthesis ? { synthesis: input.synthesis } : {}),
        ...(input.run.completionQuality === "partial"
          ? { extra: ["- Completion quality: partial (incomplete coverage)"] }
          : {}),
      }),
    },
    ...synthesisSections,
    {
      title: "Recommendation",
      content: sections.get("Recommendation") ?? recommendationFallback,
    },
    {
      title: "Risks",
      content:
        input.run.completionQuality === "partial"
          ? `Incomplete coverage: unavailable panel perspectives${failures.some((failure) => failure.reason === "timeout") ? " include timeout failures" : ""}. ${sections.get("Risks") ?? ""}`.trim()
          : (sections.get("Risks") ?? "Not specified by the judge."),
    },
    {
      title: "Next Step",
      content:
        sections.get("Next Step") ??
        "Review the recommendation and decide whether to act on it.",
    },
    { title: "Run Metadata", content: formatRunMetadata(input.run) },
  ];
  const runDetails = formatRunDetails({
    panelOutputs,
    failures,
    ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
    ...(input.judgeObservation
      ? { judgeObservation: input.judgeObservation }
      : {}),
    ...(input.synthesis ? { synthesis: input.synthesis } : {}),
  });
  if (runDetails) reportSections.splice(-1, 0, runDetails);
  return renderReport(reportSections);
}

export function renderFailureReport(input: RenderFailureReportInput): string {
  const phase = input.run.phase ?? "unknown";
  return renderReport([
    {
      title: "Summary",
      content: "Fusion failed before it could produce a final report.",
    },
    {
      title: "Agent Status",
      content: formatAgentStatus({
        ...(input.panelOutputs !== undefined
          ? { panelOutputs: input.panelOutputs }
          : {}),
        ...(input.failures !== undefined ? { failures: input.failures } : {}),
        judgeStatus: `failed - ${firstLine(input.error)}`,
        ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
        extra: [`- Phase: ${phase}`],
      }),
    },
    ...emptySynthesisSections({
      ...(input.synthesis ? { synthesis: input.synthesis } : {}),
      reason: "fusion failed",
      select: {
        consensus: "No consensus was available because fusion failed.",
        disagreements:
          "No disagreements were synthesized because fusion failed.",
        uniqueInsights:
          "No unique insights were synthesized because fusion failed.",
        blindSpots:
          "The failure may hide panel disagreements, missing evidence, or provider-specific errors.",
      },
      ...(input.panel ? { panel: input.panel } : {}),
    }),
    { title: "Recommendation", content: "No recommendation is available." },
    {
      title: "Risks",
      content: `Fusion failed in phase ${phase}: ${input.error}`,
    },
    {
      title: "Next Step",
      content: "Fix the reported error and retry /fusion.",
    },
    { title: "Run Metadata", content: formatRunMetadata(input.run) },
  ]);
}

export function renderCancelledReport(
  input: RenderCancelledReportInput,
): string {
  const target = input.targetRunId ?? "not started";
  return renderReport([
    { title: "Summary", content: "Fusion cancellation was requested." },
    {
      title: "Agent Status",
      content: formatAgentStatus({
        ...(input.panelOutputs !== undefined
          ? { panelOutputs: input.panelOutputs }
          : {}),
        ...(input.failures !== undefined ? { failures: input.failures } : {}),
        judgeStatus: "cancelled or not completed",
        ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
        extra: [
          `- Phase: ${input.run.phase ?? "unknown"}`,
          `- Cancellation method: ${input.method}`,
          `- Target run: ${target}`,
        ],
      }),
    },
    ...emptySynthesisSections({
      ...(input.synthesis ? { synthesis: input.synthesis } : {}),
      reason: "fusion was cancelled",
      select: {
        consensus:
          "No final consensus was available because fusion was cancelled.",
        disagreements:
          "No final disagreements were synthesized because fusion was cancelled.",
        uniqueInsights:
          "No final unique insights were synthesized because fusion was cancelled.",
        blindSpots:
          "Cancellation may leave in-flight panel or judge output incomplete.",
      },
      ...(input.panel ? { panel: input.panel } : {}),
    }),
    { title: "Recommendation", content: "No recommendation is available." },
    {
      title: "Risks",
      content: `The target subagent run (${target}) may still need inspection if it does not stop promptly.`,
    },
    {
      title: "Next Step",
      content: "Inspect the subagent run if it does not stop promptly.",
    },
    { title: "Run Metadata", content: formatRunMetadata(input.run) },
  ]);
}

function renderReport(sections: readonly ReportSection[]): string {
  return [
    "# Fusion Report",
    ...sections.flatMap((section) => [
      "",
      `## ${section.title}`,
      formatSectionContent(section.content),
    ]),
  ].join("\n");
}

function formatSectionContent(content: string | readonly string[]): string {
  const text = typeof content === "string" ? content : content.join("\n");
  return text.trim() || "None.";
}

interface RunDetailsInput {
  panelOutputs: readonly PanelOutput[];
  failures: readonly FailedPanelSummary[];
  judgeModel?: string;
  judgeObservation?: RunObservation;
  synthesis?: FusionSynthesisMode;
}

function formatRunDetails(input: RunDetailsInput): ReportSection | undefined {
  const entries = [
    ...input.panelOutputs.map((item) => ({
      label: formatPanelName(item),
      status: "completed",
      configuredModel: item.configuredModel ?? item.model,
      observation: item.observation,
    })),
    ...input.failures.map((item) => ({
      label: formatPanelName(item),
      status: item.reason === "stopped-after-agreement" ? "stopped" : "failed",
      configuredModel: item.configuredModel ?? item.model,
      observation: item.observation,
    })),
  ];
  if (input.judgeObservation) {
    entries.push({
      label: synthesisLabel(input.synthesis),
      status: "completed",
      configuredModel: input.judgeModel,
      observation: input.judgeObservation,
    });
  }
  if (!entries.some((entry) => entry.observation)) return undefined;

  const observations = entries.map((entry) => entry.observation ?? {});
  const providerFailures = summarizeProviderFailures(
    observations.flatMap((observation) => observation.providerFailures ?? []),
  );
  const lines = entries.map(
    (entry) =>
      `- ${entry.label} (${entry.status}): ${formatObservation(entry.observation ?? {}, entry.configuredModel)}`,
  );
  lines.push(
    `- Aggregate model time: ${formatTotal(observations, (observation) => observation.durationMs, formatDuration)}`,
    `- Total input tokens: ${formatTotal(observations, (observation) => observation.usage?.inputTokens, formatTokens)}`,
    `- Total output tokens: ${formatTotal(observations, (observation) => observation.usage?.outputTokens, formatTokens)}`,
    `- Total estimated cost: ${formatTotal(observations, (observation) => observation.usage?.costUsd, formatCost)}`,
  );
  if (providerFailures.length > 0) {
    lines.push("- Model issues:");
    lines.push(
      ...providerFailures.map(
        (failure) => `  - ${formatProviderFailure(failure)}`,
      ),
    );
  }
  return { title: "Run Details", content: lines };
}

function formatObservation(
  observation: RunObservation,
  configuredModel?: string,
): string {
  return [
    observation.model ??
      (configuredModel ? `${configuredModel} (configured)` : "model unknown"),
    observation.durationMs !== undefined
      ? formatDuration(observation.durationMs)
      : "time unknown",
    formatUsage(observation),
  ].join(" · ");
}

function formatUsage(observation: RunObservation): string {
  const input = observation.usage?.inputTokens;
  const output = observation.usage?.outputTokens;
  const cost = observation.usage?.costUsd;
  return [
    input !== undefined ? `in ${formatTokens(input)}` : "input unknown",
    output !== undefined ? `out ${formatTokens(output)}` : "output unknown",
    cost !== undefined ? formatCost(cost) : "cost unknown",
  ].join(", ");
}

function formatProviderFailure(failure: ProviderFailure): string {
  const target = failure.model
    ? `${failure.provider}/${failure.model.split("/").slice(1).join("/")}`
    : failure.provider;
  return `${target}: ${failure.message}${failure.count && failure.count > 1 ? ` (x${failure.count})` : ""}`;
}

function formatTotal(
  observations: readonly RunObservation[],
  read: (observation: RunObservation) => number | undefined,
  format: (value: number) => string,
): string {
  const values = observations.map(read);
  if (values.some((value) => value === undefined)) return "unknown";
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return format(total);
}

function formatDuration(value: number): string {
  return value >= 100 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatAgentStatus(options: AgentStatusOptions): string[] {
  const hasPanelStatus =
    options.panelOutputs !== undefined || options.failures !== undefined;
  const outputs = [...(options.panelOutputs ?? [])].sort(comparePanelItems);
  const failures = [...(options.failures ?? [])].sort(comparePanelItems);
  const lines: string[] = [];

  if (hasPanelStatus) {
    lines.push(`- Successful panelists: ${outputs.length}`);
    lines.push(`- Failed panelists: ${failures.length}`);
    for (const output of outputs) {
      lines.push(`- ${formatPanelName(output)}: succeeded`);
      lines.push(...formatPanelDetails(output));
    }
    for (const failure of failures) {
      lines.push(
        `- ${formatPanelName(failure)}: failed - ${firstLine(failure.summary)}`,
      );
      lines.push(...formatPanelDetails(failure));
    }
  } else {
    lines.push("- Panel status: not available");
  }

  lines.push(`- ${synthesisLabel(options.synthesis)}: ${options.judgeStatus}`);
  if (options.judgeModel) {
    lines.push(`  Configured model: ${options.judgeModel}`);
  }
  if (options.extra) lines.push(...options.extra);
  return lines;
}

function formatPanelDetails(
  item: Pick<
    PanelOutput,
    | "agent"
    | "role"
    | "model"
    | "configuredModel"
    | "observation"
    | "artifactPath"
    | "sessionPath"
  >,
): string[] {
  return [
    `  Agent: ${item.agent}`,
    ...(item.role ? [`  Role: ${item.role}`] : []),
    ...(item.observation?.model
      ? [`  Model: ${item.observation.model}`]
      : (item.configuredModel ?? item.model)
        ? [`  Configured model: ${item.configuredModel ?? item.model}`]
        : []),
    ...(item.configuredModel &&
    item.observation?.model &&
    item.configuredModel !== item.observation.model
      ? [`  Configured model: ${item.configuredModel}`]
      : []),
    ...(item.artifactPath ? [`  Artifact: ${item.artifactPath}`] : []),
    ...(item.sessionPath ? [`  Session: ${item.sessionPath}`] : []),
  ];
}

function formatRunMetadata(run: ReportRun): string[] {
  return [
    `- Fusion run: ${run.id}`,
    `- Profile: ${run.profileName}`,
    ...(run.phase ? [`- Phase: ${run.phase}`] : []),
    `- Prompt: ${firstLine(run.prompt)}`,
    ...(run.chainRunId ? [`- Chain run: ${run.chainRunId}`] : []),
    ...(run.panelRunId ? [`- Panel run: ${run.panelRunId}`] : []),
    ...(run.panelStopReason === "agreement"
      ? ["- Panel stopped after strong agreement"]
      : []),
    ...(run.judgeRunId
      ? [
          `- ${run.chainRunId ? "Fallback judge run" : "Judge run"}: ${run.judgeRunId}`,
        ]
      : []),
    ...(typeof run.createdAt === "number"
      ? [`- Created: ${formatTimestamp(run.createdAt)}`]
      : []),
    ...(typeof run.updatedAt === "number"
      ? [`- Updated: ${formatTimestamp(run.updatedAt)}`]
      : []),
  ];
}

function parseMarkdownSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let currentTitle: string | undefined;
  let currentLines: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      storeSection(sections, currentTitle, currentLines);
      currentTitle = heading[1]?.trim();
      currentLines = [];
      continue;
    }
    if (currentTitle) currentLines.push(line);
  }
  storeSection(sections, currentTitle, currentLines);
  return sections;
}

function storeSection(
  sections: Map<string, string>,
  title: string | undefined,
  lines: readonly string[],
): void {
  if (!title) return;
  const content = lines.join("\n").trim();
  if (content) sections.set(title, content);
}

function stripReportTitle(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => !/^#\s+Fusion Report\s*$/.test(line.trim()))
    .join("\n")
    .trim();
}

function judgeSummary(
  outputs: readonly PanelOutput[],
  failures: readonly FailedPanelSummary[],
): string {
  if (failures.length > 0) {
    return `Fusion completed with ${outputs.length} successful ${plural(outputs.length, "panelist")} and ${failures.length} failed ${plural(failures.length, "panelist")}.`;
  }
  if (outputs.length > 0) {
    return `Fusion completed with ${outputs.length} successful ${plural(outputs.length, "panelist")}.`;
  }
  return "Fusion judge completed.";
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function formatPanelName(
  item: Pick<PanelOutput, "index" | "id" | "label">,
): string {
  return panelItemLabel(item);
}

function comparePanelItems(
  left: Pick<PanelOutput, "index">,
  right: Pick<PanelOutput, "index">,
): number {
  return left.index - right.index;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "(empty)";
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}
