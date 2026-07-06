import {
  loadFusionConfig,
  resolveProfile as resolveFusionProfile,
  type ResolvedFusionProfile,
} from "./config.js";
import { FusionArgsError } from "./errors.js";
import {
  renderCancelledReport,
  renderFailureReport,
  renderJudgeReport,
  renderPanelFailureReport,
  renderSinglePanelReport,
} from "./report.js";
import { extractPanelResults } from "./result-extract.js";
import {
  buildJudgeSpawnParams,
  buildPanelSpawnParams,
  type FailedPanelSummary,
  type PanelOutput,
} from "./run-builder.js";
import { FusionRunStore, FusionRunStoreError } from "./run-store.js";
import {
  clearFusionUi,
  extractFusionProgressCounts,
  formatProgressCounts,
  publishFusionStatus,
  type FusionProgressCounts,
  type FusionUi,
} from "./status.js";
import type { FusionConfig, FusionProfile, FusionRun } from "./types.js";
import { parseFusionArgs, type ParsedFusionArgs } from "./commands.js";
import type { SubagentsTargetParams } from "./subagents-rpc.js";

export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export type FusionNotifyType = "info" | "warning" | "error";

export interface FusionCommandUi extends FusionUi {
  notify(message: string, type?: FusionNotifyType): void;
}

export interface FusionCommandContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  sessionManager: {
    getEntries(): readonly unknown[];
  };
  ui: FusionCommandUi;
}

export interface FusionRpcClientLike {
  ping(): Promise<unknown>;
  spawn(params: object): Promise<unknown>;
  status(params?: SubagentsTargetParams): Promise<unknown>;
  stop(params: SubagentsTargetParams): Promise<unknown>;
  interrupt(params: SubagentsTargetParams): Promise<unknown>;
}

export interface FusionMessageSink {
  sendMessage(message: {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }): void;
}

export interface FusionOrchestratorDeps {
  rpc: FusionRpcClientLike;
  runStore?: FusionRunStore;
  sendMessage?: FusionMessageSink["sendMessage"];
  loadConfig?: typeof loadFusionConfig;
  resolveProfile?: typeof resolveFusionProfile;
}

export type FusionCommandResult =
  | { status: "started"; run: FusionRun }
  | { status: "done"; run: FusionRun; report: string }
  | { status: "failed"; error: string; report?: string }
  | { status: "conflict"; activeRunId: string }
  | { status: "cancelled"; run: FusionRun; report: string }
  | { status: "ignored" };

export class FusionOrchestrator {
  private readonly rpc: FusionRpcClientLike;
  private readonly runStore: FusionRunStore;
  private readonly sendMessage: FusionMessageSink["sendMessage"] | undefined;
  private readonly loadConfig: typeof loadFusionConfig;
  private readonly resolveProfile: typeof resolveFusionProfile;
  private context: FusionCommandContext | undefined;
  private activeProfile: FusionProfile | undefined;
  private activePanelOutputs: PanelOutput[] = [];
  private activePanelFailures: FailedPanelSummary[] = [];
  private installWarning: string | undefined;
  private configWarning: string | undefined;

  constructor(deps: FusionOrchestratorDeps) {
    this.rpc = deps.rpc;
    this.runStore = deps.runStore ?? new FusionRunStore();
    this.sendMessage = deps.sendMessage;
    this.loadConfig = deps.loadConfig ?? loadFusionConfig;
    this.resolveProfile = deps.resolveProfile ?? resolveFusionProfile;
  }

  async startRun(
    input: string | ParsedFusionArgs,
    ctx: FusionCommandContext,
  ): Promise<FusionCommandResult> {
    this.context = ctx;

    let args: ParsedFusionArgs;
    try {
      args = typeof input === "string" ? parseFusionArgs(input) : input;
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.notify(ctx, message, "error");
      return { status: "failed", error: message };
    }

    const existing = this.runStore.getActiveRun();
    if (existing) {
      const message = `Fusion run ${existing.id} is already active.`;
      this.notify(ctx, message, "warning");
      return { status: "conflict", activeRunId: existing.id };
    }

    try {
      await this.rpc.ping();
      this.installWarning = undefined;
    } catch (error: unknown) {
      const message = `pi-subagents RPC is unavailable: ${errorMessage(error)}`;
      this.installWarning = message;
      this.notify(ctx, message, "error");
      return { status: "failed", error: message };
    }

    let resolved: ResolvedFusionProfile;
    try {
      const config = await this.loadConfig(ctx);
      resolved = this.resolveProfile(config, args.profile);
      this.configWarning = undefined;
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.configWarning = message;
      this.notify(ctx, message, "error");
      return { status: "failed", error: message };
    }

    const run = this.runStore.startRun({
      prompt: args.prompt,
      profileName: resolved.name,
    });
    this.activeProfile = resolved.profile;
    this.activePanelOutputs = [];
    this.activePanelFailures = [];
    publishFusionStatus(ctx, run);

    try {
      const spawnResult = await this.rpc.spawn(
        buildPanelSpawnParams(resolved.profile, args.prompt),
      );
      const panelRunId = extractSubagentRunId(spawnResult);
      if (!panelRunId) {
        throw new FusionArgsError(
          "pi-subagents spawn did not return a panel run ID.",
        );
      }
      const updated = this.runStore.updateRun(run.id, { panelRunId });
      publishFusionStatus(ctx, updated);
      this.notify(ctx, `Fusion panel started: ${panelRunId}`, "info");
      return { status: "started", run: updated };
    } catch (error: unknown) {
      return this.failActiveRun(errorMessage(error));
    }
  }

  async handleSubagentComplete(payload: unknown): Promise<FusionCommandResult> {
    const active = this.runStore.getActiveRun();
    if (!active) return { status: "ignored" };

    const completedRunId = extractSubagentRunId(payload);
    if (active.phase === "panel") {
      if (!active.panelRunId || completedRunId !== active.panelRunId) {
        return { status: "ignored" };
      }
      return this.handlePanelComplete(active, payload);
    }

    if (active.phase === "judge") {
      if (!active.judgeRunId || completedRunId !== active.judgeRunId) {
        return { status: "ignored" };
      }
      return this.handleJudgeComplete(active, payload);
    }

    return { status: "ignored" };
  }

  async refreshStatus(targetRunId?: string): Promise<unknown | undefined> {
    const active = this.runStore.getActiveRun();
    const runId = targetRunId ?? activeRunId(active);
    if (!runId) return undefined;

    const payload = await this.rpc.status({ id: runId });
    const progress = extractFusionProgressCounts(payload);
    if (active) publishFusionStatus(this.context, active, progress);
    return payload;
  }

  async cancelActiveRun(
    ctx: FusionCommandContext,
  ): Promise<FusionCommandResult> {
    this.context = ctx;
    const active = this.runStore.getActiveRun();
    if (!active) {
      this.notify(ctx, "No active fusion run.", "info");
      return { status: "ignored" };
    }

    const targetRunId = activeRunId(active);
    let method: "stop" | "interrupt" | "local" = "local";
    if (targetRunId) {
      try {
        await this.rpc.stop({ id: targetRunId });
        method = "stop";
      } catch (stopError: unknown) {
        this.installWarning = `Subagent stop failed for ${targetRunId}: ${errorMessage(stopError)}`;
        try {
          await this.rpc.interrupt({ id: targetRunId });
          method = "interrupt";
        } catch (interruptError: unknown) {
          const message = `Could not cancel subagent run ${targetRunId}: ${errorMessage(interruptError)}`;
          this.notify(ctx, message, "error");
          return { status: "failed", error: message };
        }
      }
    }

    const report = renderCancelledReport({
      run: active,
      method,
      ...(targetRunId ? { targetRunId } : {}),
      panelOutputs: this.activePanelOutputs,
      failures: this.activePanelFailures,
    });
    const cancelled = this.runStore.cancelRun(active.id, {
      report,
      error: `Cancellation requested with ${method}.`,
    });
    this.postMessage("fusion-report", report, { runId: cancelled.id });
    this.clearActiveRuntime();
    this.clearUi();
    this.notify(ctx, `Fusion run ${cancelled.id} cancelled.`, "info");
    return { status: "cancelled", run: cancelled, report };
  }

  restore(
    ctx: FusionCommandContext,
  ): ReturnType<FusionRunStore["restoreFromSession"]> {
    this.context = ctx;
    const summary = this.runStore.restoreFromSession(ctx);
    this.clearActiveRuntime();
    clearFusionUi(ctx);
    return summary;
  }

  clearUi(ctx: FusionCommandContext | undefined = this.context): void {
    clearFusionUi(ctx);
  }

  async showStatus(ctx: FusionCommandContext): Promise<string> {
    this.context = ctx;
    const report = await this.getStatusReport();
    this.postMessage("fusion-status", report);
    return report;
  }

  async getStatusReport(): Promise<string> {
    const active = this.runStore.getActiveRun();
    let progress: FusionProgressCounts | undefined;
    let statusWarning: string | undefined;

    if (active) {
      const targetRunId = activeRunId(active);
      if (targetRunId) {
        try {
          const payload = await this.refreshStatus(targetRunId);
          progress = extractFusionProgressCounts(payload);
        } catch (error: unknown) {
          statusWarning = `Could not refresh ${targetRunId}: ${errorMessage(error)}`;
        }
      }
      return formatFusionStatusReport({
        active,
        ...(progress ? { progress } : {}),
        warnings: this.warnings(statusWarning),
      });
    }

    return formatFusionStatusReport({
      last: this.runStore.getLastRunSummary(),
      warnings: this.warnings(),
    });
  }

  getActiveRun(): FusionRun | undefined {
    return this.runStore.getActiveRun();
  }

  private async handlePanelComplete(
    active: FusionRun,
    payload: unknown,
  ): Promise<FusionCommandResult> {
    const profile = this.activeProfile;
    if (!profile) {
      return this.failActiveRun(
        "Fusion panel completed, but the active profile was not available.",
      );
    }

    const statusPayload = await this.refreshStatusOrPayload(
      active.panelRunId,
      payload,
    );
    const extracted = extractPanelResults(statusPayload, {
      panel: profile.panel,
    });
    if (!extracted.ok) {
      return this.failActiveRun(
        `${extracted.error.message} (${extracted.error.path})`,
      );
    }

    this.activePanelOutputs = extracted.outputs;
    this.activePanelFailures = extracted.failures;

    if (extracted.outputs.length === 0) {
      const report = renderPanelFailureReport({
        run: active,
        failures: extracted.failures,
      });
      return this.failActiveRun(
        "No fusion panelists completed successfully.",
        report,
      );
    }

    if (extracted.outputs.length === 1) {
      const report = renderSinglePanelReport({
        run: active,
        output: extracted.outputs[0]!,
        failures: extracted.failures,
      });
      return this.completeActiveRun(report);
    }

    try {
      const spawnResult = await this.rpc.spawn(
        buildJudgeSpawnParams({
          profile,
          prompt: active.prompt,
          panelOutputs: extracted.outputs,
          failedPanelists: extracted.failures,
        }),
      );
      const judgeRunId = extractSubagentRunId(spawnResult);
      if (!judgeRunId) {
        throw new FusionArgsError(
          "pi-subagents spawn did not return a judge run ID.",
        );
      }
      const updated = this.runStore.updateRun(active.id, {
        phase: "judge",
        judgeRunId,
      });
      publishFusionStatus(this.context, updated);
      this.notify(this.context, `Fusion judge started: ${judgeRunId}`, "info");
      return { status: "started", run: updated };
    } catch (error: unknown) {
      return this.failActiveRun(errorMessage(error));
    }
  }

  private async handleJudgeComplete(
    active: FusionRun,
    payload: unknown,
  ): Promise<FusionCommandResult> {
    const statusPayload = await this.refreshStatusOrPayload(
      active.judgeRunId,
      payload,
    );
    const output = extractJudgeOutput(statusPayload);
    if (!output.ok) return this.failActiveRun(output.error);

    const report = renderJudgeReport({
      run: active,
      judgeOutput: output.output,
      panelOutputs: this.activePanelOutputs,
      failures: this.activePanelFailures,
    });
    return this.completeActiveRun(report);
  }

  private async refreshStatusOrPayload(
    runId: string | undefined,
    payload: unknown,
  ): Promise<unknown> {
    if (!runId) return payload;
    try {
      return (await this.refreshStatus(runId)) ?? payload;
    } catch (error: unknown) {
      this.installWarning = `Could not refresh subagent run ${runId}: ${errorMessage(error)}`;
      return payload;
    }
  }

  private completeActiveRun(report: string): FusionCommandResult {
    const active = this.runStore.getActiveRun();
    if (!active) return { status: "failed", error: "No active fusion run." };
    const done = this.runStore.completeRun(active.id, { report });
    this.postMessage("fusion-report", report, { runId: done.id });
    this.clearActiveRuntime();
    this.clearUi();
    return { status: "done", run: done, report };
  }

  private failActiveRun(
    error: string,
    report = this.defaultFailureReport(error),
  ): FusionCommandResult {
    const active = this.runStore.getActiveRun();
    if (!active) return { status: "failed", error };
    let failed: FusionRun;
    try {
      failed = this.runStore.failRun(active.id, { error, report });
    } catch (storeError: unknown) {
      if (!(storeError instanceof FusionRunStoreError)) throw storeError;
      return { status: "failed", error: errorMessage(storeError), report };
    }
    this.postMessage("fusion-report", report, { runId: failed.id });
    this.clearActiveRuntime();
    this.clearUi();
    this.notify(this.context, `Fusion run ${failed.id} failed.`, "error");
    return { status: "failed", error, report };
  }

  private defaultFailureReport(error: string): string {
    const active = this.runStore.getActiveRun();
    if (!active) return error;
    return renderFailureReport({
      run: active,
      error,
      panelOutputs: this.activePanelOutputs,
      failures: this.activePanelFailures,
    });
  }

  private clearActiveRuntime(): void {
    this.activeProfile = undefined;
    this.activePanelOutputs = [];
    this.activePanelFailures = [];
  }

  private warnings(extra?: string): string[] {
    return [this.installWarning, this.configWarning, extra].filter(
      (warning): warning is string => Boolean(warning),
    );
  }

  private postMessage(
    customType: "fusion-report" | "fusion-status",
    content: string,
    details?: unknown,
  ): void {
    this.sendMessage?.({
      customType,
      content,
      display: true,
      ...(details !== undefined ? { details } : {}),
    });
  }

  private notify(
    ctx: FusionCommandContext | undefined,
    message: string,
    type: FusionNotifyType,
  ): void {
    ctx?.ui.notify(message, type);
  }
}

export function extractSubagentRunId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = firstNonBlankString(
    payload.runId,
    payload.id,
    payload.asyncId,
  );
  if (direct) return direct;
  if (isRecord(payload.details)) {
    const details = firstNonBlankString(
      payload.details.runId,
      payload.details.id,
      payload.details.asyncId,
    );
    if (details) return details;
  }
  if (isRecord(payload.data)) return extractSubagentRunId(payload.data);
  return undefined;
}

export function extractJudgeOutput(
  payload: unknown,
): { ok: true; output: string } | { ok: false; error: string } {
  const result = findFirstResult(payload);
  if (result) {
    const failed = resultFailed(result);
    const output = firstNonBlankString(
      result.output,
      result.finalOutput,
      result.summary,
      result.text,
    );
    if (failed) {
      return {
        ok: false,
        error:
          firstNonBlankString(result.error, output) ??
          "Fusion judge failed without output.",
      };
    }
    if (output) return { ok: true, output };
    const artifactPath = extractArtifactPath(result);
    if (artifactPath)
      return { ok: true, output: `Output artifact: ${artifactPath}` };
  }

  const output = firstNonBlankStringFromPayload(payload);
  if (output) return { ok: true, output };
  return { ok: false, error: "Fusion judge completed without output." };
}

function formatFusionStatusReport(input: {
  active?: FusionRun;
  last?: ReturnType<FusionRunStore["getLastRunSummary"]>;
  progress?: FusionProgressCounts;
  warnings: readonly string[];
}): string {
  const lines = ["Fusion status"];
  if (input.active) {
    lines.push("State: active");
    lines.push(`Run: ${input.active.id}`);
    lines.push(`Profile: ${input.active.profileName}`);
    lines.push(`Phase: ${input.active.phase}`);
    if (input.active.panelRunId)
      lines.push(`Panel run: ${input.active.panelRunId}`);
    if (input.active.judgeRunId)
      lines.push(`Judge run: ${input.active.judgeRunId}`);
    lines.push(
      `Progress: ${input.progress ? formatProgressCounts(input.progress) : "unknown"}`,
    );
  } else if (input.last) {
    lines.push("State: idle");
    lines.push(`Last run: ${input.last.id}`);
    lines.push(`Profile: ${input.last.profileName}`);
    lines.push(`Phase: ${input.last.phase}`);
    if (input.last.panelRunId)
      lines.push(`Panel run: ${input.last.panelRunId}`);
    if (input.last.judgeRunId)
      lines.push(`Judge run: ${input.last.judgeRunId}`);
  } else {
    lines.push("State: idle");
    lines.push("Last run: none");
  }

  if (input.warnings.length === 0) lines.push("Warnings: none");
  else
    lines.push("Warnings:", ...input.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}

function activeRunId(run: FusionRun | undefined): string | undefined {
  if (!run) return undefined;
  return run.phase === "judge" ? run.judgeRunId : run.panelRunId;
}

function findFirstResult(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  if (Array.isArray(payload.results) && isRecord(payload.results[0])) {
    return payload.results[0];
  }
  if (isRecord(payload.details)) {
    if (
      Array.isArray(payload.details.results) &&
      isRecord(payload.details.results[0])
    ) {
      return payload.details.results[0];
    }
  }
  if (isRecord(payload.data)) return findFirstResult(payload.data);
  return undefined;
}

function resultFailed(result: Record<string, unknown>): boolean {
  if (result.success === false) return true;
  if (result.timedOut === true || result.interrupted === true) return true;
  if (firstNonBlankString(result.error)) return true;
  const status = firstString(result.status, result.state);
  if (!status) return false;
  return status === "failed" || status === "paused" || status === "detached";
}

function firstNonBlankStringFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = firstNonBlankString(
    payload.output,
    payload.finalOutput,
    payload.summary,
    payload.text,
  );
  if (direct) return direct;
  if (isRecord(payload.details)) {
    const fromDetails = firstNonBlankString(
      payload.details.output,
      payload.details.finalOutput,
      payload.details.summary,
      payload.details.text,
    );
    if (fromDetails) return fromDetails;
  }
  if (isRecord(payload.data))
    return firstNonBlankStringFromPayload(payload.data);
  return undefined;
}

function extractArtifactPath(
  result: Record<string, unknown>,
): string | undefined {
  const direct = firstString(result.artifactPath, result.savedOutputPath);
  if (direct) return direct;
  if (isRecord(result.artifactPaths))
    return firstString(result.artifactPaths.outputPath);
  if (isRecord(result.outputReference))
    return firstString(result.outputReference.path);
  return undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstNonBlankString(
  ...values: readonly unknown[]
): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
