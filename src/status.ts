import type { FusionRun } from "./types.js";

export const FUSION_STATUS_KEY = "fusion";

export interface FusionProgressCounts {
  total?: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface FusionUi {
  setStatus(key: string, text: string | undefined): void;
}

export interface FusionUiContext {
  hasUI: boolean;
  ui: FusionUi;
}

export function publishFusionStatus(
  ctx: FusionUiContext | undefined,
  run: Pick<
    FusionRun,
    "id" | "phase" | "profileName" | "chainRunId" | "panelRunId" | "judgeRunId"
  >,
  progress?: FusionProgressCounts,
  phaseLabel?: string,
): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setStatus(
    FUSION_STATUS_KEY,
    formatFusionStatusText(run, progress, phaseLabel),
  );
}

export function clearFusionUi(ctx: FusionUiContext | undefined): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setStatus(FUSION_STATUS_KEY, undefined);
}

export function formatFusionStatusText(
  run: Pick<
    FusionRun,
    "phase" | "profileName" | "chainRunId" | "panelRunId" | "judgeRunId"
  >,
  progress?: FusionProgressCounts,
  phaseLabel?: string,
): string {
  const activeRunId =
    run.phase === "judge" ? run.judgeRunId : (run.chainRunId ?? run.panelRunId);
  const phase = phaseLabel ?? run.phase;
  if (progress) {
    return `fusion: panel · ${formatProgressCounts(progress)} · ${run.profileName}`;
  }
  if (activeRunId) {
    return `fusion: ${phase} · ${run.profileName} · ${activeRunId}`;
  }
  return `fusion: ${phase} · starting · ${run.profileName}`;
}

export function extractFusionProgressCounts(
  payload: unknown,
): FusionProgressCounts | undefined {
  const container = findProgressContainer(payload);
  if (!container || container.length === 0) return undefined;

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

export function isTerminalFusionProgress(payload: unknown): boolean {
  const progressPayload = findTerminalProgressPayload(payload);
  const progress = progressPayload
    ? extractFusionProgressCounts(progressPayload)
    : undefined;
  return Boolean(
    progress &&
    progress.total !== undefined &&
    progress.total > 0 &&
    progress.pending === 0 &&
    progress.running === 0,
  );
}

type ProgressStatus = "pending" | "running" | "completed" | "failed";

function findProgressContainer(
  payload: unknown,
): readonly unknown[] | undefined {
  if (!isRecord(payload)) return undefined;
  const progress = nonEmptyArray(payload.progress);
  if (progress) return progress;
  const results = nonEmptyArray(payload.results);
  if (results) return results;
  const steps = nonEmptyArray(payload.steps);
  if (steps) return steps;
  if (isRecord(payload.details)) {
    const detailsProgress = nonEmptyArray(payload.details.progress);
    if (detailsProgress) return detailsProgress;
    const detailsResults = nonEmptyArray(payload.details.results);
    if (detailsResults) return detailsResults;
    const detailsSteps = nonEmptyArray(payload.details.steps);
    if (detailsSteps) return detailsSteps;
  }
  if (isRecord(payload.data)) return findProgressContainer(payload.data);
  return undefined;
}

function findTerminalProgressPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  if (Array.isArray(payload.progress)) return { progress: payload.progress };
  if (Array.isArray(payload.steps)) return { steps: payload.steps };
  if (isRecord(payload.details)) {
    if (Array.isArray(payload.details.progress)) {
      return { progress: payload.details.progress };
    }
    if (Array.isArray(payload.details.steps)) {
      return { steps: payload.details.steps };
    }
  }
  return isRecord(payload.data)
    ? findTerminalProgressPayload(payload.data)
    : undefined;
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

function nonEmptyArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) && value.length > 0
    ? (value as readonly unknown[])
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
