import type { FailedPanelSummary, PanelOutput } from "./run-builder.js";
import type { FusionRun } from "./types.js";

export interface RenderPanelFailureReportInput {
  run: Pick<FusionRun, "id" | "prompt" | "profileName" | "panelRunId">;
  failures: readonly FailedPanelSummary[];
  error?: string;
}

export interface RenderSinglePanelReportInput {
  run: Pick<FusionRun, "id" | "prompt" | "profileName" | "panelRunId">;
  output: PanelOutput;
  failures: readonly FailedPanelSummary[];
}

export interface RenderJudgeReportInput {
  run: Pick<
    FusionRun,
    "id" | "prompt" | "profileName" | "panelRunId" | "judgeRunId"
  >;
  judgeOutput: string;
}

export interface RenderFailureReportInput {
  run: Pick<
    FusionRun,
    "id" | "prompt" | "profileName" | "phase" | "panelRunId" | "judgeRunId"
  >;
  error: string;
}

export interface RenderCancelledReportInput {
  run: Pick<
    FusionRun,
    "id" | "prompt" | "profileName" | "phase" | "panelRunId" | "judgeRunId"
  >;
  method: "stop" | "interrupt" | "local";
  targetRunId?: string;
}

export function renderPanelFailureReport(
  input: RenderPanelFailureReportInput,
): string {
  return [
    "# Fusion Report",
    "",
    "## Summary",
    "No panelists completed successfully. The fusion run could not produce a recommendation.",
    "",
    "## Agent Status",
    ...formatRunLines(input.run),
    `- Successful panelists: 0`,
    `- Failed panelists: ${input.failures.length}`,
    ...formatFailures(input.failures),
    ...(input.error ? ["", "## Error", input.error] : []),
    "",
    "## Next Step",
    "Inspect the failed subagent run IDs or artifacts, then retry /fusion after fixing the cause.",
  ].join("\n");
}

export function renderSinglePanelReport(
  input: RenderSinglePanelReportInput,
): string {
  return [
    "# Fusion Report",
    "",
    "## Summary",
    "Only one panelist completed successfully, so pi-fusion skipped the judge step.",
    "",
    "## Agent Status",
    ...formatRunLines(input.run),
    `- Successful panelists: 1`,
    `- Failed panelists: ${input.failures.length}`,
    `- ${formatPanelName(input.output)}: succeeded`,
    ...formatFailures(input.failures),
    "",
    `## ${formatPanelName(input.output)}`,
    input.output.output.trim(),
    "",
    "## Next Step",
    "Use this single-panel result directly, or rerun /fusion if you need judge synthesis.",
  ].join("\n");
}

export function renderJudgeReport(input: RenderJudgeReportInput): string {
  const output = input.judgeOutput.trim();
  if (output.startsWith("# Fusion Report")) return output;
  return [
    "# Fusion Report",
    "",
    "## Agent Status",
    ...formatRunLines(input.run),
    "",
    "## Judge Output",
    output || "Judge completed without output.",
  ].join("\n");
}

export function renderFailureReport(input: RenderFailureReportInput): string {
  return [
    "# Fusion Report",
    "",
    "## Summary",
    "Fusion failed before it could produce a final report.",
    "",
    "## Agent Status",
    ...formatRunLines(input.run),
    `- Phase: ${input.run.phase}`,
    "",
    "## Error",
    input.error,
    "",
    "## Next Step",
    "Fix the reported error and retry /fusion.",
  ].join("\n");
}

export function renderCancelledReport(
  input: RenderCancelledReportInput,
): string {
  const target = input.targetRunId ?? "not started";
  return [
    "# Fusion Report",
    "",
    "## Summary",
    "Fusion cancellation was requested.",
    "",
    "## Agent Status",
    ...formatRunLines(input.run),
    `- Phase: ${input.run.phase}`,
    `- Cancellation method: ${input.method}`,
    `- Target run: ${target}`,
    "",
    "## Next Step",
    "Inspect the subagent run if it does not stop promptly.",
  ].join("\n");
}

function formatRunLines(
  run: Pick<
    FusionRun,
    "id" | "prompt" | "profileName" | "panelRunId" | "judgeRunId"
  >,
): string[] {
  return [
    `- Fusion run: ${run.id}`,
    `- Profile: ${run.profileName}`,
    `- Prompt: ${firstLine(run.prompt)}`,
    ...(run.panelRunId ? [`- Panel run: ${run.panelRunId}`] : []),
    ...(run.judgeRunId ? [`- Judge run: ${run.judgeRunId}`] : []),
  ];
}

function formatFailures(failures: readonly FailedPanelSummary[]): string[] {
  return failures.flatMap((failure) => [
    `- ${formatPanelName(failure)}: failed - ${firstLine(failure.summary)}`,
    ...(failure.artifactPath ? [`  Artifact: ${failure.artifactPath}`] : []),
    ...(failure.sessionPath ? [`  Session: ${failure.sessionPath}`] : []),
  ]);
}

function formatPanelName(
  item: Pick<PanelOutput, "index" | "id" | "label">,
): string {
  return item.label ?? item.id ?? `Panelist ${item.index + 1}`;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "(empty)";
}
