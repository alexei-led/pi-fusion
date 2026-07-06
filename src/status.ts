import type { FusionRun } from "./types.js";

export const FUSION_STATUS_KEY = "fusion";
export const FUSION_WIDGET_KEY = "fusion-panel";

export interface FusionProgressCounts {
  total?: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface FusionUi {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: readonly string[] | undefined): void;
}

export interface FusionUiContext {
  hasUI: boolean;
  ui: FusionUi;
}

export function publishFusionStatus(
  ctx: FusionUiContext | undefined,
  run: Pick<
    FusionRun,
    "id" | "phase" | "profileName" | "panelRunId" | "judgeRunId"
  >,
  progress?: FusionProgressCounts,
): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setStatus(FUSION_STATUS_KEY, formatFusionStatusText(run, progress));
  ctx.ui.setWidget(FUSION_WIDGET_KEY, buildFusionWidgetLines(run, progress));
}

export function clearFusionUi(ctx: FusionUiContext | undefined): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setStatus(FUSION_STATUS_KEY, undefined);
  ctx.ui.setWidget(FUSION_WIDGET_KEY, undefined);
}

export function formatFusionStatusText(
  run: Pick<FusionRun, "phase" | "profileName" | "panelRunId" | "judgeRunId">,
  progress?: FusionProgressCounts,
): string {
  const activeRunId = run.phase === "judge" ? run.judgeRunId : run.panelRunId;
  const progressText = progress ? ` ${formatProgressCounts(progress)}` : "";
  const runText = activeRunId ? ` ${activeRunId}` : " starting";
  return `fusion: ${run.phase} ${run.profileName}${runText}${progressText}`;
}

export function buildFusionWidgetLines(
  run: Pick<
    FusionRun,
    "id" | "phase" | "profileName" | "panelRunId" | "judgeRunId"
  >,
  progress?: FusionProgressCounts,
): string[] {
  return [
    `Fusion ${run.phase} · ${run.profileName}`,
    `Run: ${run.id}`,
    ...(run.panelRunId ? [`Panel: ${run.panelRunId}`] : []),
    ...(run.judgeRunId ? [`Judge: ${run.judgeRunId}`] : []),
    ...(progress ? [`Progress: ${formatProgressCounts(progress)}`] : []),
  ];
}

export function extractFusionProgressCounts(
  payload: unknown,
): FusionProgressCounts | undefined {
  const container = findProgressContainer(payload);
  if (!container) return undefined;

  const counts: FusionProgressCounts = {
    total: container.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };

  for (const item of container) {
    const status = classifyProgressItem(item);
    if (status === "pending") counts.pending++;
    else if (status === "running") counts.running++;
    else if (status === "completed") counts.completed++;
    else counts.failed++;
  }

  return counts;
}

export function formatProgressCounts(progress: FusionProgressCounts): string {
  const total =
    progress.total ??
    progress.pending + progress.running + progress.completed + progress.failed;
  return `${progress.completed}/${total} done, ${progress.running} running, ${progress.failed} failed`;
}

type ProgressStatus = "pending" | "running" | "completed" | "failed";

function findProgressContainer(
  payload: unknown,
): readonly unknown[] | undefined {
  if (!isRecord(payload)) return undefined;
  if (Array.isArray(payload.progress)) return payload.progress;
  if (Array.isArray(payload.results)) return payload.results;
  if (isRecord(payload.details)) {
    if (Array.isArray(payload.details.progress))
      return payload.details.progress;
    if (Array.isArray(payload.details.results)) return payload.details.results;
  }
  if (isRecord(payload.data)) return findProgressContainer(payload.data);
  return undefined;
}

function classifyProgressItem(value: unknown): ProgressStatus {
  if (!isRecord(value)) return "failed";
  if (value.success === true) return "completed";
  if (value.success === false) return "failed";
  if (value.timedOut === true || value.interrupted === true) return "failed";
  const status = firstString(value.status, value.state);
  if (status === "pending" || status === "queued") return "pending";
  if (status === "running" || status === "active") return "running";
  if (status === "completed" || status === "complete" || status === "done") {
    return "completed";
  }
  if (status === "failed" || status === "paused" || status === "detached") {
    return "failed";
  }
  if (typeof value.exitCode === "number") {
    return value.exitCode === 0 ? "completed" : "failed";
  }
  return firstString(value.output, value.finalOutput, value.summary, value.text)
    ? "completed"
    : "pending";
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
