import {
  loadFusionConfig,
  resolveProfile as resolveFusionProfile,
  type ResolvedFusionProfile,
} from "./config.js";
import { FusionArgsError } from "./errors.js";
import { parseFusionArgs } from "./fusion-args.js";
import { decidePanelCompletion } from "./panel-completion.js";
import {
  renderCancelledReport,
  renderFailureReport,
  renderJudgeReport,
} from "./report.js";
import {
  extractPanelResults,
  type ExtractPanelResultsSuccess,
} from "./result-extract.js";
import { appendThinkingSuffix, buildPanelSpawnParams } from "./run-builder.js";
import { FusionRunStore, FusionRunStoreError } from "./run-store.js";
import {
  clearFusionUi,
  extractFusionProgressCounts,
  formatProgressCounts,
  publishFusionStatus,
  type FusionProgressCounts,
  type FusionUi,
} from "./status.js";
import {
  readSubagentResultArtifact,
  readSubagentStatusArtifact,
} from "./subagent-artifacts.js";
import type {
  FailedPanelSummary,
  FusionProfile,
  FusionRun,
  PanelOutput,
  ParsedFusionArgs,
} from "./types.js";
import {
  extractRunObservation,
  hasStrongPanelAgreement,
  mergeRunObservations,
} from "./run-observations.js";
import type { SubagentsTargetParams } from "./subagents-rpc.js";

export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

const RECONCILE_INTERVAL_MS = 2_000;

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

interface RunLifecycleSnapshot {
  statusPayload?: unknown;
  resultPayload?: unknown;
  resultIsTerminal: boolean;
}

export class FusionOrchestrator {
  private readonly rpc: FusionRpcClientLike;
  private readonly runStore: FusionRunStore;
  private readonly sendMessage: FusionMessageSink["sendMessage"] | undefined;
  private readonly loadConfig: typeof loadFusionConfig;
  private readonly resolveProfile: typeof resolveFusionProfile;
  private context: FusionCommandContext | undefined;
  private activeProfile: FusionProfile | undefined;
  private installWarning: string | undefined;
  private configWarning: string | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private pendingCompletionPayload: unknown;

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

    const args = typeof input === "string" ? parseFusionArgs(input) : input;
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

    let run: FusionRun;
    try {
      run = this.runStore.startRun({
        prompt: args.prompt,
        profileName: resolved.name,
        phase: "panel",
      });
    } catch (error: unknown) {
      if (!(error instanceof FusionRunStoreError)) throw error;
      const active = this.runStore.getActiveRun();
      if (active) {
        this.notify(
          ctx,
          `Fusion run ${active.id} is already active.`,
          "warning",
        );
        return { status: "conflict", activeRunId: active.id };
      }
      return { status: "failed", error: errorMessage(error) };
    }
    this.activeProfile = resolved.profile;
    publishFusionStatus(ctx, run);

    try {
      const spawnResult = await this.rpc.spawn(
        buildPanelSpawnParams(resolved.profile, args.prompt),
      );
      const panelRunId = extractSubagentRunId(spawnResult);
      if (!panelRunId) {
        throw new FusionArgsError(
          "pi-subagents spawn did not return a fusion panel run ID.",
        );
      }
      const panelAsyncDir = extractSubagentAsyncDir(spawnResult);
      const current = this.runStore.getActiveRun();
      if (!current || current.id !== run.id) {
        await this.stopOrphanedRun(panelRunId);
        const cancelled = this.runStore.getLastRunSummary();
        return cancelled?.id === run.id &&
          cancelled.phase === "cancelled" &&
          cancelled.report
          ? { status: "cancelled", run: cancelled, report: cancelled.report }
          : { status: "ignored" };
      }
      const updated = this.runStore.updateRun(run.id, {
        panelRunId,
        ...(panelAsyncDir ? { panelAsyncDir } : {}),
      });
      publishFusionStatus(ctx, updated);
      this.ensureReconcileLoop();
      this.notify(
        ctx,
        `Fusion ${resolved.name} started (${resolved.profile.panel.length} panelists): "${promptPreview(args.prompt)}" — ${panelRunId}`,
        "info",
      );
      return { status: "started", run: updated };
    } catch (error: unknown) {
      const cancelled = this.runStore.getLastRunSummary();
      if (
        cancelled?.id === run.id &&
        cancelled.phase === "cancelled" &&
        cancelled.report
      ) {
        return {
          status: "cancelled",
          run: cancelled,
          report: cancelled.report,
        };
      }
      return this.failActiveRun(errorMessage(error));
    }
  }

  private async stopOrphanedRun(
    runId: string,
    kind: "panel" | "judge" = "panel",
  ): Promise<void> {
    try {
      await this.rpc.stop({ id: runId });
      return;
    } catch (stopError: unknown) {
      try {
        await this.rpc.interrupt({ id: runId });
        this.installWarning = `Orphaned ${kind} stop fell back to interrupt for ${runId}: ${errorMessage(stopError)}`;
        return;
      } catch (interruptError: unknown) {
        this.installWarning = `Could not stop orphaned ${kind} run ${runId}: ${errorMessage(interruptError)}`;
      }
    }
    this.notify(
      this.context,
      this.installWarning ?? `Could not stop orphaned ${kind} run.`,
      "warning",
    );
  }

  async handleSubagentComplete(payload: unknown): Promise<FusionCommandResult> {
    const active = this.runStore.getActiveRun();
    if (!active) return { status: "ignored" };

    const completedRunId = extractSubagentRunId(payload);
    if (!completedRunId) return { status: "ignored" };

    if (active.phase === "judge") {
      if (!active.judgeRunId || completedRunId !== active.judgeRunId) {
        return { status: "ignored" };
      }
      return this.reconcileActiveRun(payload);
    }

    const rootRunId = active.chainRunId ?? active.panelRunId;
    if (!rootRunId || completedRunId !== rootRunId) {
      return { status: "ignored" };
    }
    return this.reconcileActiveRun(payload);
  }

  async refreshStatus(
    targetRunId?: string,
    asyncDir?: string,
  ): Promise<unknown> {
    const active = this.runStore.getActiveRun();
    const runId = targetRunId ?? activeRunId(active);
    const resolvedAsyncDir = asyncDir ?? activeAsyncDir(active);

    const statusPayload =
      readSubagentStatusArtifact(resolvedAsyncDir) ??
      (runId ? await this.rpc.status({ id: runId }) : undefined);
    const progress = extractFusionProgressCounts(statusPayload);
    if (active) {
      publishFusionStatus(
        this.context,
        active,
        progress,
        deriveFusionStatusPhase(active, statusPayload),
      );
    }
    return statusPayload;
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

    if (this.runStore.getActiveRun()?.id !== active.id) {
      return { status: "ignored" };
    }

    const report = renderCancelledReport({
      run: active,
      method,
      ...(targetRunId ? { targetRunId } : {}),
      panelOutputs: storedPanelOutputs(active),
      failures: storedPanelFailures(active),
      ...withJudgeModel(
        this.activeProfile
          ? configuredJudgeModel(this.activeProfile)
          : undefined,
      ),
    });
    const cancelled = this.runStore.cancelRun(active.id, {
      ...(active.chainRunId ? { chainRunId: active.chainRunId } : {}),
      ...(active.panelRunId ? { panelRunId: active.panelRunId } : {}),
      ...(active.judgeRunId ? { judgeRunId: active.judgeRunId } : {}),
      report,
      error: `Cancellation requested with ${method}.`,
    });
    this.postMessage("fusion-report", report, { runId: cancelled.id });
    this.clearActiveRuntime();
    this.clearUi();
    this.notify(ctx, `Fusion run ${cancelled.id} cancelled.`, "info");
    return { status: "cancelled", run: cancelled, report };
  }

  async restore(
    ctx: FusionCommandContext,
  ): Promise<ReturnType<FusionRunStore["restoreFromSession"]>> {
    this.context = ctx;
    const summary = this.runStore.restoreFromSession(ctx);
    this.clearActiveRuntime();

    const active = this.runStore.getActiveRun();
    if (!active) {
      this.stopReconcileLoop();
      clearFusionUi(ctx);
      return summary;
    }

    try {
      const config = await this.loadConfig(ctx);
      this.activeProfile = this.resolveProfile(
        config,
        active.profileName,
      ).profile;
      this.configWarning = undefined;
    } catch (error: unknown) {
      const message = `Could not restore fusion profile "${active.profileName}": ${errorMessage(error)}`;
      this.configWarning = message;
      this.notify(ctx, message, "warning");
    }
    publishFusionStatus(ctx, active);
    this.ensureReconcileLoop();
    await this.reconcileActiveRun();
    return summary;
  }

  clearUi(ctx: FusionCommandContext | undefined = this.context): void {
    clearFusionUi(ctx);
  }

  dispose(): void {
    this.stopReconcileLoop();
  }

  async showStatus(ctx: FusionCommandContext): Promise<string> {
    this.context = ctx;
    const report = await this.getStatusReport();
    this.postMessage("fusion-status", report);
    return report;
  }

  async getStatusReport(): Promise<string> {
    if (this.runStore.getActiveRun()) {
      await this.reconcileActiveRun();
    }

    const active = this.runStore.getActiveRun();
    let progress: FusionProgressCounts | undefined;
    let statusWarning: string | undefined;
    let statusDetails: FusionStatusDetails | undefined;

    if (active) {
      const targetRunId = activeRunId(active);
      if (targetRunId) {
        try {
          const payload = await this.refreshStatus(
            targetRunId,
            activeAsyncDir(active),
          );
          progress = extractFusionProgressCounts(payload);
          statusDetails = buildFusionStatusDetails(
            active,
            this.activeProfile,
            payload,
          );
        } catch (error: unknown) {
          statusWarning = `Could not refresh ${targetRunId}: ${errorMessage(error)}`;
        }
      }
      return formatFusionStatusReport({
        active,
        ...(progress ? { progress } : {}),
        ...(statusDetails ? { details: statusDetails } : {}),
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

  private async reconcileActiveRun(
    eventPayload?: unknown,
  ): Promise<FusionCommandResult> {
    if (this.reconciling) {
      if (eventPayload !== undefined) {
        this.pendingCompletionPayload = eventPayload;
      }
      return { status: "ignored" };
    }
    const active = this.runStore.getActiveRun();
    if (!active) return { status: "ignored" };

    this.reconciling = true;
    try {
      if (active.phase === "panel") {
        return this.handleLegacyPanelComplete(active, eventPayload);
      }
      if (active.phase === "chain") {
        return this.handleChainComplete(active, eventPayload);
      }
      if (active.phase === "judge") {
        return this.handleJudgeComplete(active, eventPayload);
      }
      return { status: "ignored" };
    } finally {
      this.reconciling = false;
      const pendingPayload = this.pendingCompletionPayload;
      this.pendingCompletionPayload = undefined;
      if (pendingPayload !== undefined) {
        void this.reconcileActiveRun(pendingPayload).catch((error: unknown) => {
          const message = `Could not reconcile completed fusion run: ${errorMessage(error)}`;
          this.installWarning = message;
          this.notify(this.context, message, "warning");
        });
      }
    }
  }

  private async handleChainComplete(
    active: FusionRun,
    payload: unknown,
  ): Promise<FusionCommandResult> {
    const profile = this.activeProfile;
    if (!profile) {
      return this.failActiveRun(
        "Fusion chain is active, but the profile could not be restored.",
      );
    }

    const snapshot = await this.loadRunLifecycle({
      run: active,
      ...(active.chainRunId ? { runId: active.chainRunId } : {}),
      ...(active.chainAsyncDir ? { asyncDir: active.chainAsyncDir } : {}),
      eventPayload: payload,
    });
    const terminalPayload =
      snapshot.resultPayload ?? snapshot.statusPayload ?? payload;
    if (
      !snapshot.resultIsTerminal &&
      !isTerminalSubagentState(extractSubagentState(terminalPayload))
    ) {
      return { status: "ignored" };
    }

    const extracted = extractPanelResults(
      snapshot.resultPayload ?? snapshot.statusPayload ?? payload,
      {
        panel: profile.panel,
        limit: profile.panel.length,
      },
    );
    if (!extracted.ok) {
      return this.failActiveRun(
        `${extracted.error.message} (${extracted.error.path})`,
      );
    }

    const observedPanels = mergePanelObservations(
      extracted,
      snapshot.statusPayload,
      profile,
    );
    const updated = this.storePanelResults(
      active.id,
      observedPanels.outputs,
      observedPanels.failures,
    );

    if (hasJudgeResult(snapshot.resultPayload, profile.panel.length)) {
      const output = extractJudgeOutput(snapshot.resultPayload, {
        resultIndex: profile.panel.length,
      });
      if (!output.ok) return this.failActiveRun(output.error);

      const judgeObservation = mergeRunObservations(
        extractRunObservation(
          findStepsArray(snapshot.statusPayload)[profile.panel.length] ??
            snapshot.statusPayload,
        ),
        extractRunObservation(
          findResult(snapshot.resultPayload, profile.panel.length) ??
            snapshot.resultPayload,
        ),
      );
      const observed = this.runStore.updateRun(updated.id, {
        judgeObservation,
      });
      const report = renderJudgeReport({
        run: observed,
        judgeOutput: output.output,
        panelOutputs: storedPanelOutputs(observed),
        failures: storedPanelFailures(observed),
        ...withJudgeModel(configuredJudgeModel(profile)),
        judgeObservation,
      });
      return this.completeActiveRun(report);
    }

    return this.finishPanelCompletion(
      updated,
      profile,
      observedPanels.outputs,
      observedPanels.failures,
      { fallbackJudge: true },
    );
  }

  private async handleLegacyPanelComplete(
    active: FusionRun,
    payload: unknown,
  ): Promise<FusionCommandResult> {
    const profile = this.activeProfile;
    if (!profile) {
      return this.failActiveRun(
        "Fusion panel completed, but the active profile was not available.",
      );
    }

    const snapshot = await this.loadRunLifecycle({
      run: active,
      ...(active.panelRunId ? { runId: active.panelRunId } : {}),
      ...(active.panelAsyncDir
        ? { asyncDir: active.panelAsyncDir }
        : active.chainAsyncDir
          ? { asyncDir: active.chainAsyncDir }
          : {}),
      eventPayload: payload,
    });

    if (!active.panelStopReason) {
      const partial = extractPanelResults(snapshot.statusPayload, {
        panel: profile.panel,
        completedOnly: true,
      });
      if (
        partial.ok &&
        shouldStopWhenPanelAgrees(profile, partial.outputs, partial.failures)
      ) {
        return this.stopPanelAfterAgreement(
          active,
          partial,
          profile.panel.length,
        );
      }
    }

    const terminalPayload =
      snapshot.resultPayload ?? snapshot.statusPayload ?? payload;
    if (
      !snapshot.resultIsTerminal &&
      !isTerminalSubagentState(extractSubagentState(terminalPayload))
    ) {
      return { status: "ignored" };
    }

    const extracted = extractPanelResults(
      snapshot.resultPayload ?? snapshot.statusPayload ?? payload,
      {
        panel: profile.panel,
        limit: profile.panel.length,
        ...(active.panelStoppedIndices
          ? { stoppedPanelIndices: active.panelStoppedIndices }
          : {}),
      },
    );
    if (!extracted.ok) {
      return this.failActiveRun(
        `${extracted.error.message} (${extracted.error.path})`,
      );
    }

    const observedPanels = mergePanelObservations(
      extracted,
      snapshot.statusPayload,
      profile,
    );
    const updated = this.storePanelResults(
      active.id,
      observedPanels.outputs,
      observedPanels.failures,
    );

    return this.finishPanelCompletion(
      updated,
      profile,
      observedPanels.outputs,
      observedPanels.failures,
      { fallbackJudge: false },
    );
  }

  private async stopPanelAfterAgreement(
    active: FusionRun,
    partial: ExtractPanelResultsSuccess,
    panelSize: number,
  ): Promise<FusionCommandResult> {
    if (!active.panelRunId) return { status: "ignored" };

    let method: "stop" | "interrupt" = "stop";
    try {
      await this.rpc.stop({ id: active.panelRunId });
    } catch (stopError: unknown) {
      try {
        await this.rpc.interrupt({ id: active.panelRunId });
        method = "interrupt";
      } catch (interruptError: unknown) {
        this.installWarning = `Could not stop panel run ${active.panelRunId} after agreement: ${errorMessage(interruptError)}`;
        this.notify(this.context, this.installWarning, "warning");
        return { status: "ignored" };
      }
      this.installWarning = `Panel stop fell back to interrupt for ${active.panelRunId}: ${errorMessage(stopError)}`;
    }

    if (this.runStore.getActiveRun()?.id !== active.id) {
      return { status: "ignored" };
    }

    const completedIndices = new Set([
      ...partial.outputs.map((output) => output.index),
      ...partial.failures.map((failure) => failure.index),
    ]);
    const panelStoppedIndices = Array.from(
      { length: panelSize },
      (_, index) => index,
    ).filter((index) => !completedIndices.has(index));
    const updated = this.runStore.updateRun(active.id, {
      panelStopReason: "agreement",
      panelStoppedIndices,
      panelOutputs: partial.outputs,
      panelFailures: partial.failures,
    });
    publishFusionStatus(
      this.context,
      updated,
      undefined,
      "stopping after panel agreement",
    );
    this.notify(
      this.context,
      `Panel agreement found; stopping remaining panelists (${method}).`,
      "info",
    );
    return { status: "started", run: updated };
  }

  private async finishPanelCompletion(
    run: FusionRun,
    profile: FusionProfile,
    panelOutputs: readonly PanelOutput[],
    panelFailures: readonly FailedPanelSummary[],
    options: { fallbackJudge: boolean },
  ): Promise<FusionCommandResult> {
    const decision = decidePanelCompletion({
      run,
      profile,
      panelOutputs,
      panelFailures,
      fallbackJudge: options.fallbackJudge,
    });

    if (decision.kind === "fail") {
      return this.failActiveRun(decision.error, decision.report);
    }
    if (decision.kind === "complete") {
      return this.completeActiveRun(decision.report);
    }

    try {
      const spawnResult = await this.rpc.spawn(decision.params);
      const judgeRunId = extractSubagentRunId(spawnResult);
      if (!judgeRunId) {
        throw new FusionArgsError(decision.missingRunIdError);
      }
      const judgeAsyncDir = extractSubagentAsyncDir(spawnResult);
      if (this.runStore.getActiveRun()?.id !== run.id) {
        await this.stopOrphanedRun(judgeRunId, "judge");
        return { status: "ignored" };
      }
      const nextRun = this.runStore.updateRun(run.id, {
        phase: "judge",
        judgeRunId,
        ...(judgeAsyncDir ? { judgeAsyncDir } : {}),
        panelOutputs: [...panelOutputs],
        panelFailures: [...panelFailures],
      });
      publishFusionStatus(this.context, nextRun);
      this.notify(
        this.context,
        `${decision.notification}: ${judgeRunId}`,
        "info",
      );
      return { status: "started", run: nextRun };
    } catch (error: unknown) {
      return this.failActiveRun(errorMessage(error));
    }
  }

  private async handleJudgeComplete(
    active: FusionRun,
    payload: unknown,
  ): Promise<FusionCommandResult> {
    const snapshot = await this.loadRunLifecycle({
      run: active,
      ...(active.judgeRunId ? { runId: active.judgeRunId } : {}),
      ...(active.judgeAsyncDir ? { asyncDir: active.judgeAsyncDir } : {}),
      eventPayload: payload,
    });
    const terminalPayload =
      snapshot.resultPayload ?? snapshot.statusPayload ?? payload;
    if (
      !snapshot.resultIsTerminal &&
      !isTerminalSubagentState(extractSubagentState(terminalPayload))
    ) {
      return { status: "ignored" };
    }

    const output = extractJudgeOutput(
      snapshot.resultPayload ?? snapshot.statusPayload ?? payload,
    );
    if (!output.ok) return this.failActiveRun(output.error);

    const judgeModel = this.activeProfile
      ? configuredJudgeModel(this.activeProfile)
      : undefined;
    const judgeObservation = mergeRunObservations(
      extractRunObservation(
        findStepsArray(snapshot.statusPayload)[0] ?? snapshot.statusPayload,
      ),
      extractRunObservation(
        findResult(
          snapshot.resultPayload ?? snapshot.statusPayload ?? payload,
        ) ?? snapshot.resultPayload,
      ),
    );
    const observed = this.runStore.updateRun(active.id, {
      judgeObservation,
    });
    const report = renderJudgeReport({
      run: observed,
      judgeOutput: output.output,
      panelOutputs: storedPanelOutputs(observed),
      failures: storedPanelFailures(observed),
      ...withJudgeModel(judgeModel),
      judgeObservation,
    });
    return this.completeActiveRun(report);
  }

  private async loadRunLifecycle(input: {
    run: FusionRun;
    runId?: string;
    asyncDir?: string;
    eventPayload?: unknown;
  }): Promise<RunLifecycleSnapshot> {
    const eventPayloadMatches =
      input.eventPayload !== undefined &&
      extractSubagentRunId(input.eventPayload) === input.runId;

    let statusPayload = readSubagentStatusArtifact(input.asyncDir);
    if (statusPayload === undefined && input.runId) {
      try {
        statusPayload = await this.rpc.status({ id: input.runId });
      } catch (error: unknown) {
        this.installWarning = `Could not refresh subagent run ${input.runId}: ${errorMessage(error)}`;
      }
    }

    const progress = extractFusionProgressCounts(statusPayload);
    if (progress) {
      publishFusionStatus(
        this.context,
        input.run,
        progress,
        deriveFusionStatusPhase(input.run, statusPayload),
      );
    }

    const eventHasResults = hasResultsArray(input.eventPayload);
    if (eventPayloadMatches && eventHasResults) {
      return {
        statusPayload,
        resultPayload: input.eventPayload,
        resultIsTerminal: true,
      };
    }

    const artifactResult = readSubagentResultArtifact({
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.asyncDir ? { asyncDir: input.asyncDir } : {}),
    });
    if (hasResultsArray(artifactResult)) {
      return {
        statusPayload,
        resultPayload: artifactResult,
        resultIsTerminal: true,
      };
    }

    if (hasResultsArray(statusPayload)) {
      const resultIsTerminal =
        eventPayloadMatches ||
        isTerminalSubagentState(extractSubagentState(statusPayload));
      return {
        statusPayload,
        resultPayload: statusPayload,
        resultIsTerminal,
      };
    }

    if (isTerminalSubagentState(extractSubagentState(statusPayload))) {
      return {
        statusPayload,
        resultPayload: statusPayload,
        resultIsTerminal: true,
      };
    }

    if (eventPayloadMatches) {
      return {
        statusPayload,
        resultPayload: input.eventPayload,
        resultIsTerminal: isTerminalSubagentState(
          extractSubagentState(input.eventPayload),
        ),
      };
    }

    return { statusPayload, resultIsTerminal: false };
  }

  private storePanelResults(
    runId: string,
    panelOutputs: readonly PanelOutput[],
    panelFailures: readonly FailedPanelSummary[],
  ): FusionRun {
    return this.runStore.updateRun(runId, {
      panelOutputs: [...panelOutputs],
      panelFailures: [...panelFailures],
    });
  }

  private completeActiveRun(report: string): FusionCommandResult {
    const active = this.runStore.getActiveRun();
    if (!active) return { status: "failed", error: "No active fusion run." };
    const done = this.runStore.completeRun(active.id, {
      ...(active.chainRunId ? { chainRunId: active.chainRunId } : {}),
      ...(active.panelRunId ? { panelRunId: active.panelRunId } : {}),
      ...(active.judgeRunId ? { judgeRunId: active.judgeRunId } : {}),
      report,
    });
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
      failed = this.runStore.failRun(active.id, {
        ...(active.chainRunId ? { chainRunId: active.chainRunId } : {}),
        ...(active.panelRunId ? { panelRunId: active.panelRunId } : {}),
        ...(active.judgeRunId ? { judgeRunId: active.judgeRunId } : {}),
        report,
        error,
      });
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
      panelOutputs: storedPanelOutputs(active),
      failures: storedPanelFailures(active),
      ...withJudgeModel(
        this.activeProfile
          ? configuredJudgeModel(this.activeProfile)
          : undefined,
      ),
    });
  }

  private clearActiveRuntime(): void {
    this.activeProfile = undefined;
    this.stopReconcileLoop();
  }

  private ensureReconcileLoop(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileActiveRun().catch((error: unknown) => {
        const message = `Could not reconcile fusion run: ${errorMessage(error)}`;
        this.installWarning = message;
        this.notify(this.context, message, "warning");
      });
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
  }

  private stopReconcileLoop(): void {
    if (!this.reconcileTimer) return;
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
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

export function extractSubagentAsyncDir(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = firstNonBlankString(payload.asyncDir);
  if (direct) return direct;
  if (isRecord(payload.details)) {
    const details = firstNonBlankString(payload.details.asyncDir);
    if (details) return details;
  }
  if (isRecord(payload.data)) return extractSubagentAsyncDir(payload.data);
  return undefined;
}

export function extractJudgeOutput(
  payload: unknown,
  options: { resultIndex?: number } = {},
): { ok: true; output: string } | { ok: false; error: string } {
  const result = findResult(payload, options.resultIndex);
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
    if (artifactPath) {
      return { ok: true, output: `Output artifact: ${artifactPath}` };
    }
  }

  const output = firstNonBlankStringFromPayload(payload);
  if (output) return { ok: true, output };
  return { ok: false, error: "Fusion judge completed without output." };
}

interface FusionStatusPanelLine {
  label: string;
  role?: string;
  model?: string;
  status: string;
  activity?: string;
}

interface FusionStatusJudgeLine {
  label: string;
  model?: string;
  status: string;
  activity?: string;
}

interface FusionStatusDetails {
  prompt: string;
  phaseLabel?: string;
  panelists?: readonly FusionStatusPanelLine[];
  judge?: FusionStatusJudgeLine;
  fallbackJudge?: FusionStatusJudgeLine;
}

function formatFusionStatusReport(input: {
  active?: FusionRun;
  last?: ReturnType<FusionRunStore["getLastRunSummary"]>;
  progress?: FusionProgressCounts;
  details?: FusionStatusDetails;
  warnings: readonly string[];
}): string {
  const lines = ["Fusion status"];
  if (input.active) {
    lines.push("State: active");
    lines.push(`Run: ${input.active.id}`);
    lines.push(
      `Prompt: ${firstLine(input.details?.prompt ?? input.active.prompt)}`,
    );
    lines.push(`Profile: ${input.active.profileName}`);
    lines.push(`Phase: ${input.details?.phaseLabel ?? input.active.phase}`);
    if (input.active.chainRunId)
      lines.push(`Chain run: ${input.active.chainRunId}`);
    else if (input.active.panelRunId)
      lines.push(`Panel run: ${input.active.panelRunId}`);
    if (input.active.judgeRunId) {
      lines.push(
        `${input.active.chainRunId ? "Fallback judge run" : "Judge run"}: ${input.active.judgeRunId}`,
      );
    }
    lines.push(
      `Progress: ${input.progress ? formatProgressCounts(input.progress) : "unknown"}`,
    );
    appendStatusDetails(lines, input.details);
  } else if (input.last) {
    lines.push("State: idle");
    lines.push(`Last run: ${input.last.id}`);
    lines.push(`Prompt: ${firstLine(input.last.prompt)}`);
    lines.push(`Profile: ${input.last.profileName}`);
    lines.push(`Phase: ${input.last.phase}`);
    if (input.last.chainRunId)
      lines.push(`Chain run: ${input.last.chainRunId}`);
    else if (input.last.panelRunId)
      lines.push(`Panel run: ${input.last.panelRunId}`);
    if (input.last.judgeRunId) {
      lines.push(
        `${input.last.chainRunId ? "Fallback judge run" : "Judge run"}: ${input.last.judgeRunId}`,
      );
    }
  } else {
    lines.push("State: idle");
    lines.push("Last run: none");
  }

  if (input.warnings.length === 0) lines.push("Warnings: none");
  else {
    lines.push("Warnings:", ...input.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

function appendStatusDetails(
  lines: string[],
  details: FusionStatusDetails | undefined,
): void {
  if (!details) return;
  if (details.panelists && details.panelists.length > 0) {
    lines.push("", "Panelists");
    for (const panelist of details.panelists) {
      lines.push(`- ${panelist.label}: ${panelist.status}`);
      if (panelist.role) lines.push(`  Role: ${panelist.role}`);
      if (panelist.model) lines.push(`  Model: ${panelist.model}`);
      if (panelist.activity) lines.push(`  Activity: ${panelist.activity}`);
    }
  }
  if (details.judge) {
    lines.push("", details.judge.label);
    lines.push(`- Status: ${details.judge.status}`);
    if (details.judge.model) lines.push(`  Model: ${details.judge.model}`);
    if (details.judge.activity)
      lines.push(`  Activity: ${details.judge.activity}`);
  }
  if (details.fallbackJudge) {
    lines.push("", details.fallbackJudge.label);
    lines.push(`- Status: ${details.fallbackJudge.status}`);
    if (details.fallbackJudge.model) {
      lines.push(`  Model: ${details.fallbackJudge.model}`);
    }
    if (details.fallbackJudge.activity) {
      lines.push(`  Activity: ${details.fallbackJudge.activity}`);
    }
  }
}

function activeRunId(run: FusionRun | undefined): string | undefined {
  if (!run) return undefined;
  if (run.phase === "judge") return run.judgeRunId;
  return run.chainRunId ?? run.panelRunId;
}

function activeAsyncDir(run: FusionRun | undefined): string | undefined {
  if (!run) return undefined;
  if (run.phase === "judge") return run.judgeAsyncDir;
  return run.phase === "panel"
    ? (run.panelAsyncDir ?? run.chainAsyncDir)
    : run.chainAsyncDir;
}

function buildFusionStatusDetails(
  run: FusionRun,
  profile: FusionProfile | undefined,
  payload: unknown,
): FusionStatusDetails {
  const details: FusionStatusDetails = {
    prompt: run.prompt,
    phaseLabel: deriveFusionStatusPhase(run, payload),
  };
  if (!profile) return details;

  const judgeModel = configuredJudgeModel(profile);

  if (run.phase === "judge") {
    details.panelists = buildCompletedPanelStatusLines(
      profile.panel,
      storedPanelOutputs(run),
      storedPanelFailures(run),
    );
    details.fallbackJudge = {
      label: run.chainRunId ? "Fallback judge" : "Judge",
      ...(judgeModel ? { model: judgeModel } : {}),
      status: describeStandaloneRunStatus(payload),
    };
    return details;
  }

  const steps = findStepsArray(payload);
  const panelSteps = steps.slice(0, profile.panel.length);
  const panelists = profile.panel.map((member, index) => {
    const step = panelSteps[index];
    const model = configuredPanelModel(member);
    const activity = describeStepActivity(step);
    const metrics = describeStepMetrics(step);
    return {
      label: member.label,
      ...(member.role ? { role: member.role } : {}),
      ...(model ? { model } : {}),
      status: describePanelStatus(step),
      ...([activity, metrics].filter(Boolean).length > 0
        ? { activity: [activity, metrics].filter(Boolean).join(" · ") }
        : {}),
    };
  });
  details.panelists = panelists;

  const judgeActivity = describeStepActivity(steps[profile.panel.length]);
  const judgeMetrics = describeStepMetrics(steps[profile.panel.length]);
  details.judge = {
    label: "Judge",
    ...(judgeModel ? { model: judgeModel } : {}),
    status: describeChainJudgeStatus(steps[profile.panel.length], panelists),
    ...([judgeActivity, judgeMetrics].filter(Boolean).length > 0
      ? { activity: [judgeActivity, judgeMetrics].filter(Boolean).join(" · ") }
      : {}),
  };
  return details;
}

function deriveFusionStatusPhase(
  run: Pick<FusionRun, "phase" | "chainRunId">,
  payload: unknown,
): string {
  if (run.phase === "judge") {
    return run.chainRunId ? "fallback judge" : "judge";
  }
  if (run.phase !== "chain") return run.phase;

  const steps = findStepsArray(payload);
  if (steps.length === 0) return "chain";
  const judgeStatus = normalizeStatusLabel(steps.at(-1));
  if (judgeStatus === "running" || judgeStatus === "completed") {
    return "judge";
  }
  const panelSteps = steps.slice(0, -1);
  if (panelSteps.some((step) => normalizeStatusLabel(step) === "running")) {
    return "panel";
  }
  if (judgeStatus === "pending") {
    const allPanelsFinished = panelSteps.every((step) => {
      const status = normalizeStatusLabel(step);
      return status === "completed" || status === "failed";
    });
    return allPanelsFinished ? "judge" : "panel";
  }
  return "panel";
}

function buildCompletedPanelStatusLines(
  panel: FusionProfile["panel"],
  outputs: readonly PanelOutput[],
  failures: readonly FailedPanelSummary[],
): FusionStatusPanelLine[] {
  return panel.map((member, index) => {
    const model = configuredPanelModel(member);
    const output = outputs.find(
      (item) => item.id === member.id || item.index === index,
    );
    if (output) {
      return {
        label: member.label,
        ...(member.role ? { role: member.role } : {}),
        ...(model ? { model } : {}),
        status: "completed",
      };
    }
    const failure = failures.find(
      (item) => item.id === member.id || item.index === index,
    );
    return {
      label: member.label,
      ...(member.role ? { role: member.role } : {}),
      ...(model ? { model } : {}),
      status: failure ? "failed" : "unknown",
      ...(failure ? { activity: firstLine(failure.summary) } : {}),
    };
  });
}

function describePanelStatus(step: unknown): string {
  return normalizeStatusLabel(step);
}

function describeChainJudgeStatus(
  step: unknown,
  panelists: readonly FusionStatusPanelLine[],
): string {
  if (step === undefined) return "waiting for panel results";
  const normalized = normalizeStatusLabel(step);
  if (normalized === "pending") {
    const waitingOnPanel = panelists.some(
      (panelist) =>
        panelist.status !== "completed" && panelist.status !== "failed",
    );
    return waitingOnPanel ? "waiting for panel results" : "pending";
  }
  return normalized;
}

function describeStandaloneRunStatus(payload: unknown): string {
  const state = extractSubagentState(payload);
  if (state) {
    if (state === "complete" || state === "completed" || state === "done") {
      return "completed";
    }
    if (state === "running" || state === "active") return "running";
    if (state === "pending" || state === "queued") return "pending";
    if (state === "failed" || state === "paused" || state === "detached") {
      return "failed";
    }
    return state;
  }
  if (hasResultsArray(payload)) return "completed";
  return "running";
}

function normalizeStatusLabel(step: unknown): string {
  if (!isRecord(step)) return "pending";
  if (step.success === true) return "completed";
  if (step.success === false) return "failed";
  if (step.timedOut === true || step.interrupted === true) return "failed";
  if (typeof step.exitCode === "number") {
    return step.exitCode === 0 ? "completed" : "failed";
  }
  const status = firstString(step.status, step.state);
  if (status === "complete" || status === "completed" || status === "done") {
    return "completed";
  }
  if (status === "running" || status === "active") return "running";
  if (status === "pending" || status === "queued") return "pending";
  if (status === "failed" || status === "paused" || status === "detached") {
    return "failed";
  }
  return "pending";
}

function findStepsArray(payload: unknown): readonly unknown[] {
  if (!isRecord(payload)) return [];
  const direct = unknownArray(payload.steps);
  if (direct) return direct;
  if (isRecord(payload.details)) {
    const detailsSteps = unknownArray(payload.details.steps);
    if (detailsSteps) return detailsSteps;
  }
  if (isRecord(payload.data)) return findStepsArray(payload.data);
  return [];
}

function describeStepActivity(step: unknown): string | undefined {
  if (!isRecord(step)) return undefined;
  const tools = unknownArray(step.recentTools);
  const lastTool = tools?.at(-1);
  if (isRecord(lastTool)) {
    const tool = firstString(lastTool.tool) ?? "tool";
    const args = firstString(lastTool.args);
    return args ? `${tool} ${summarizeActivityArg(args)}` : tool;
  }
  const recentOutput = unknownArray(step.recentOutput)
    ?.map((item) => (typeof item === "string" ? item.trim() : ""))
    .find(Boolean);
  return recentOutput || undefined;
}

function describeStepMetrics(step: unknown): string | undefined {
  const observation = extractRunObservation(step);
  const metrics = [
    observation.durationMs !== undefined
      ? `${(observation.durationMs / 1000).toFixed(1)}s`
      : undefined,
    observation.usage?.costUsd !== undefined
      ? `$${observation.usage.costUsd.toFixed(4)}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return metrics.length > 0 ? metrics.join(", ") : undefined;
}

function summarizeActivityArg(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.length >= 3) return parts.slice(-3).join("/");
  return value;
}

function configuredPanelModel(
  member: FusionProfile["panel"][number],
): string | undefined {
  return appendThinkingSuffix(member.model, member.thinking);
}

function findResultsArray(payload: unknown): readonly unknown[] | undefined {
  if (!isRecord(payload)) return undefined;
  const directResults = unknownArray(payload.results);
  if (directResults && directResults.length > 0) return directResults;
  if (isRecord(payload.details)) {
    const detailsResults = unknownArray(payload.details.results);
    if (detailsResults && detailsResults.length > 0) return detailsResults;
  }
  if (isRecord(payload.data)) {
    const dataResults = findResultsArray(payload.data);
    if (dataResults) return dataResults;
  }
  if (directResults) return directResults;
  if (isRecord(payload.details)) return unknownArray(payload.details.results);
  return undefined;
}

function hasResultsArray(payload: unknown): boolean {
  return (findResultsArray(payload)?.length ?? 0) > 0;
}

function hasJudgeResult(payload: unknown, panelCount: number): boolean {
  return (findResultsArray(payload)?.length ?? 0) > panelCount;
}

function findResult(
  payload: unknown,
  resultIndex?: number,
): Record<string, unknown> | undefined {
  const results = findResultsArray(payload);
  if (!results || results.length === 0) return undefined;
  if (resultIndex !== undefined) {
    const indexed = results[resultIndex];
    return isRecord(indexed) ? indexed : undefined;
  }
  const first = results[0];
  return isRecord(first) ? first : undefined;
}

function resultFailed(result: Record<string, unknown>): boolean {
  if (result.success === false) return true;
  if (result.timedOut === true || result.interrupted === true) return true;
  if (firstNonBlankString(result.error)) return true;
  const status = firstString(result.status, result.state);
  if (!status) return false;
  return status === "failed" || status === "paused" || status === "detached";
}

function extractSubagentState(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = firstString(payload.state, payload.status);
  if (direct) return direct;
  const text = firstString(
    payload.text,
    isRecord(payload.details) ? payload.details.text : undefined,
  );
  const parsedText = text ? extractStateFromText(text) : undefined;
  if (parsedText) return parsedText;
  if (isRecord(payload.details)) {
    const fromDetails = firstString(
      payload.details.state,
      payload.details.status,
    );
    if (fromDetails) return fromDetails;
  }
  if (isRecord(payload.data)) return extractSubagentState(payload.data);
  return undefined;
}

function extractStateFromText(text: string): string | undefined {
  const match = text.match(/(?:^|\n)(?:State|Status):\s*([^\n\r]+)/i);
  return match?.[1]?.trim() || undefined;
}

function isTerminalSubagentState(state: string | undefined): boolean {
  return (
    state === "complete" ||
    state === "completed" ||
    state === "done" ||
    state === "failed" ||
    state === "paused" ||
    state === "detached"
  );
}

function firstNonBlankStringFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = firstNonBlankString(
    payload.output,
    payload.finalOutput,
    payload.summary,
  );
  if (direct) return direct;
  const text = firstNonBlankString(payload.text);
  if (text && !isStatusEnvelopeText(text)) return text;
  if (isRecord(payload.details)) {
    const fromDetails = firstNonBlankString(
      payload.details.output,
      payload.details.finalOutput,
      payload.details.summary,
    );
    if (fromDetails) return fromDetails;
    const detailsText = firstNonBlankString(payload.details.text);
    if (detailsText && !isStatusEnvelopeText(detailsText)) return detailsText;
  }
  if (isRecord(payload.data))
    return firstNonBlankStringFromPayload(payload.data);
  return undefined;
}

function isStatusEnvelopeText(value: string): boolean {
  return (
    /(?:^|\n)Run:\s*[^\n\r]+/i.test(value) &&
    /(?:^|\n)(?:State|Status):\s*[^\n\r]+/i.test(value)
  );
}

function extractArtifactPath(
  result: Record<string, unknown>,
): string | undefined {
  const direct = firstString(result.artifactPath, result.savedOutputPath);
  if (direct) return direct;
  if (isRecord(result.artifactPaths)) {
    return firstString(result.artifactPaths.outputPath);
  }
  if (isRecord(result.outputReference)) {
    return firstString(result.outputReference.path);
  }
  return undefined;
}

function mergePanelObservations(
  result: ExtractPanelResultsSuccess,
  statusPayload: unknown,
  profile: FusionProfile,
): ExtractPanelResultsSuccess {
  const status = extractPanelResults(statusPayload, {
    panel: profile.panel,
    completedOnly: true,
    limit: profile.panel.length,
  });
  if (!status.ok) return result;

  const observations = new Map<number, PanelOutput["observation"]>();
  for (const output of status.outputs) {
    observations.set(output.index, output.observation);
  }
  for (const failure of status.failures) {
    observations.set(failure.index, failure.observation);
  }

  return {
    ...result,
    outputs: result.outputs.map((output) =>
      withMergedObservation(output, observations.get(output.index)),
    ),
    failures: result.failures.map((failure) =>
      withMergedObservation(failure, observations.get(failure.index)),
    ),
  };
}

function withMergedObservation<T extends PanelOutput | FailedPanelSummary>(
  item: T,
  statusObservation: PanelOutput["observation"] | undefined,
): T {
  const observation = mergeRunObservations(statusObservation, item.observation);
  return hasObservationData(observation) ? { ...item, observation } : item;
}

function hasObservationData(observation: PanelOutput["observation"]): boolean {
  return Boolean(
    observation &&
    (observation.model ||
      observation.durationMs !== undefined ||
      observation.usage ||
      observation.attempts ||
      observation.providerFailures),
  );
}

function shouldStopWhenPanelAgrees(
  profile: FusionProfile,
  outputs: readonly PanelOutput[],
  failures: readonly FailedPanelSummary[],
): boolean {
  return (
    profile.stopWhenPanelAgrees === true &&
    hasStrongPanelAgreement(
      outputs,
      outputs.length + failures.length,
      profile.panel.length,
    )
  );
}

function storedPanelOutputs(run: FusionRun): readonly PanelOutput[] {
  return run.panelOutputs ?? [];
}

function storedPanelFailures(run: FusionRun): readonly FailedPanelSummary[] {
  return run.panelFailures ?? [];
}

function configuredJudgeModel(profile: FusionProfile): string | undefined {
  return appendThinkingSuffix(profile.judge.model, profile.judge.thinking);
}

function withJudgeModel(
  judgeModel: string | undefined,
): { judgeModel: string } | Record<string, never> {
  return judgeModel ? { judgeModel } : {};
}

function promptPreview(prompt: string): string {
  return firstLine(prompt).slice(0, 80);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
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

function unknownArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
