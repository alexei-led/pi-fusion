import type { FailedPanelSummary, PanelOutput } from "./run-builder.js";
import type { FusionRun } from "./types.js";

type ReportRun = Pick<
  FusionRun,
  "id" | "prompt" | "profileName" | "chainRunId" | "panelRunId" | "judgeRunId"
> &
  Partial<Pick<FusionRun, "phase" | "createdAt" | "updatedAt">>;

export interface RenderPanelFailureReportInput {
  run: ReportRun;
  failures: readonly FailedPanelSummary[];
  error?: string;
  judgeModel?: string;
}

export interface RenderSinglePanelReportInput {
  run: ReportRun;
  output: PanelOutput;
  failures: readonly FailedPanelSummary[];
  judgeModel?: string;
}

export interface RenderJudgeReportInput {
  run: ReportRun;
  judgeOutput: string;
  panelOutputs?: readonly PanelOutput[];
  failures?: readonly FailedPanelSummary[];
  judgeModel?: string;
}

export interface RenderFailureReportInput {
  run: ReportRun;
  error: string;
  panelOutputs?: readonly PanelOutput[];
  failures?: readonly FailedPanelSummary[];
  judgeModel?: string;
}

export interface RenderCancelledReportInput {
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
  | "Unique Insights"
  | "Blind Spots"
  | "Recommendation"
  | "Risks"
  | "Next Step"
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
}

export function renderPanelFailureReport(
  input: RenderPanelFailureReportInput,
): string {
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
      }),
    },
    {
      title: "Consensus",
      content: "No consensus was available because all panelists failed.",
    },
    {
      title: "Disagreements",
      content:
        "No disagreements were synthesized because the judge did not run.",
    },
    {
      title: "Unique Insights",
      content: "No panel output was available to summarize.",
    },
    {
      title: "Blind Spots",
      content:
        "All panelists failed, so the report may be missing every intended review perspective.",
    },
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
  const panelName = formatPanelName(input.output);
  return renderReport([
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
  ]);
}

export function renderJudgeReport(input: RenderJudgeReportInput): string {
  const panelOutputs = input.panelOutputs ?? [];
  const failures = input.failures ?? [];
  const sections = parseMarkdownSections(input.judgeOutput);
  const unsectionedOutput = stripReportTitle(input.judgeOutput);
  const recommendationFallback =
    sections.size === 0 && unsectionedOutput
      ? unsectionedOutput
      : "Judge completed without a recommendation.";

  return renderReport([
    {
      title: "Summary",
      content: sections.get("Summary") ?? judgeSummary(panelOutputs, failures),
    },
    {
      title: "Agent Status",
      content: formatAgentStatus({
        panelOutputs,
        failures,
        judgeStatus: "succeeded",
        ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
      }),
    },
    {
      title: "Consensus",
      content: sections.get("Consensus") ?? "Not specified by the judge.",
    },
    {
      title: "Disagreements",
      content: sections.get("Disagreements") ?? "Not specified by the judge.",
    },
    {
      title: "Unique Insights",
      content: sections.get("Unique Insights") ?? "Not specified by the judge.",
    },
    {
      title: "Blind Spots",
      content: sections.get("Blind Spots") ?? "Not specified by the judge.",
    },
    {
      title: "Recommendation",
      content: sections.get("Recommendation") ?? recommendationFallback,
    },
    {
      title: "Risks",
      content: sections.get("Risks") ?? "Not specified by the judge.",
    },
    {
      title: "Next Step",
      content:
        sections.get("Next Step") ??
        "Review the recommendation and decide whether to act on it.",
    },
    { title: "Run Metadata", content: formatRunMetadata(input.run) },
  ]);
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
    {
      title: "Consensus",
      content: "No consensus was available because fusion failed.",
    },
    {
      title: "Disagreements",
      content: "No disagreements were synthesized because fusion failed.",
    },
    {
      title: "Unique Insights",
      content: "No unique insights were synthesized because fusion failed.",
    },
    {
      title: "Blind Spots",
      content:
        "The failure may hide panel disagreements, missing evidence, or provider-specific errors.",
    },
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
    {
      title: "Consensus",
      content: "No final consensus was available because fusion was cancelled.",
    },
    {
      title: "Disagreements",
      content:
        "No final disagreements were synthesized because fusion was cancelled.",
    },
    {
      title: "Unique Insights",
      content:
        "No final unique insights were synthesized because fusion was cancelled.",
    },
    {
      title: "Blind Spots",
      content:
        "Cancellation may leave in-flight panel or judge output incomplete.",
    },
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

  lines.push(`- Judge: ${options.judgeStatus}`);
  if (options.judgeModel) lines.push(`  Model: ${options.judgeModel}`);
  if (options.extra) lines.push(...options.extra);
  return lines;
}

function formatPanelDetails(
  item: Pick<
    PanelOutput,
    "agent" | "role" | "model" | "artifactPath" | "sessionPath"
  >,
): string[] {
  return [
    `  Agent: ${item.agent}`,
    ...(item.role ? [`  Role: ${item.role}`] : []),
    ...(item.model ? [`  Model: ${item.model}`] : []),
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
    ...(run.judgeRunId ? [`- Fallback judge run: ${run.judgeRunId}`] : []),
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
  return item.label ?? item.id ?? `Panelist ${item.index + 1}`;
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
