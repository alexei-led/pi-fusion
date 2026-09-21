import { randomUUID } from "node:crypto";
import {
  DurableRunSnapshotStore,
  type DurableRunSnapshot,
} from "./durable-run-store.js";
import type {
  ExecutionLifetime,
  FusionPhase,
  FusionProfileSnapshot,
  FusionRecoveryState,
  FusionRun,
  ModelAttempt,
  PanelDecision,
  ProviderFailure,
  RunObservation,
  RunUsage,
} from "./types.js";
import { isFiniteNumber, isNonEmptyString, isRecord } from "./utils.js";
import { isReviewContext } from "./review-context.js";

export const FUSION_RUN_ENTRY_TYPE = "fusion-run";

export type FusionTerminalPhase = Extract<
  FusionPhase,
  "done" | "failed" | "cancelled"
>;

export type FusionRunSummary = Omit<
  Pick<
    FusionRun,
    | "id"
    | "executionLifetime"
    | "effectiveExecutionLifetime"
    | "requestDigest"
    | "reviewContext"
    | "cancellationRequested"
    | "processTerminalProof"
    | "observation"
    | "prompt"
    | "profileName"
    | "operationId"
    | "outputContract"
    | "completionQuality"
    | "effectiveTimeouts"
    | "recovery"
    | "phase"
    | "createdAt"
    | "updatedAt"
    | "chainRunId"
    | "panelRunId"
    | "judgeRunId"
    | "report"
    | "error"
  >,
  "phase"
> & { phase: FusionTerminalPhase };

export interface FusionRunStartInput {
  id?: string;
  spawnIntent?: FusionRun["spawnIntent"];
  reviewContext?: FusionRun["reviewContext"];
  executionLifetime?: ExecutionLifetime;
  effectiveExecutionLifetime?: ExecutionLifetime;
  requestDigest?: string;
  cancellationRequested?: boolean;
  processTerminalProof?: unknown;
  observation?: unknown;
  prompt: string;
  profileName: string;
  inlinePanel?: string[];
  baseProfileName?: string;
  operationId?: string;
  outputContract?: FusionRun["outputContract"];
  minimumSuccessfulPanelists?: FusionRun["minimumSuccessfulPanelists"];
  profileSnapshot?: FusionRun["profileSnapshot"];
  timeoutOverrides?: FusionRun["timeoutOverrides"];
  effectiveTimeouts?: FusionRun["effectiveTimeouts"];
  phase?: Exclude<FusionPhase, FusionTerminalPhase>;
  createdAt?: number;
}

export interface FusionRunPatch {
  executionLifetime?: ExecutionLifetime;
  effectiveExecutionLifetime?: ExecutionLifetime;
  requestDigest?: string;
  cancellationRequested?: boolean;
  processTerminalProof?: unknown;
  observation?: unknown;
  phase?: Exclude<FusionPhase, FusionTerminalPhase>;
  chainRunId?: string;
  chainAsyncDir?: string;
  panelRunId?: string;
  panelAsyncDir?: string;
  panelStopReason?: FusionRun["panelStopReason"];
  panelStoppedIndices?: FusionRun["panelStoppedIndices"];
  panelDeadlines?: FusionRun["panelDeadlines"];
  judgeRunId?: string;
  judgeAsyncDir?: string;
  judgeObservation?: FusionRun["judgeObservation"];
  completionQuality?: FusionRun["completionQuality"];
  panelOutputs?: FusionRun["panelOutputs"];
  panelFailures?: FusionRun["panelFailures"];
  recovery?: FusionRun["recovery"];
  /** `null` clears an intent once the RPC returned its durable remote ID. */
  spawnIntent?: FusionRun["spawnIntent"] | null;
  report?: string;
  error?: string;
  updatedAt?: number;
}

export interface FusionRunTransitionPatch {
  executionLifetime?: ExecutionLifetime;
  effectiveExecutionLifetime?: ExecutionLifetime;
  requestDigest?: string;
  cancellationRequested?: boolean;
  processTerminalProof?: unknown;
  observation?: unknown;
  chainRunId?: string;
  panelRunId?: string;
  judgeRunId?: string;
  recovery?: FusionRun["recovery"];
  spawnIntent?: FusionRun["spawnIntent"];
  report?: string;
  error?: string;
  updatedAt?: number;
}

export interface FusionRunStorePersistence {
  appendEntry(customType: string, data?: unknown): void;
}

export interface FusionRunSessionContext {
  sessionManager: {
    getEntries(): readonly unknown[];
  };
}

export interface FusionRunStoreOptions {
  now?: () => number;
  idFactory?: () => string;
  persistence?: FusionRunStorePersistence;
  directory?: string;
}

export class FusionRunStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FusionRunStoreError";
  }
}

export class FusionRunStore {
  private activeRun: FusionRun | undefined;
  private lastRunSummary: FusionRunSummary | undefined;
  private readonly runsById = new Map<string, FusionRun>();
  private readonly runIdsByOperationId = new Map<string, string>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly persistence: FusionRunStorePersistence | undefined;
  private durableStore: DurableRunSnapshotStore | undefined;
  private durableRunsById = new Map<string, FusionRun>();
  private durableRestoreError: string | undefined;
  private admissionTail: string | undefined;
  private readonly terminalRunIds = new Set<string>();
  private restoreError: string | undefined;
  private activeSelectionError: string | undefined;

  constructor(options: FusionRunStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.persistence = options.persistence;
    if (options.directory !== undefined) this.setDirectory(options.directory);
  }

  /**
   * Selects the project directory used for cross-session run snapshots.
   * Calling this after construction reloads the directory and replaces the
   * in-memory project view with the records found there.
   */
  setDirectory(directory: string): void {
    if (!directory.trim()) {
      throw new FusionRunStoreError("Fusion run directory must not be empty.");
    }
    this.durableStore = new DurableRunSnapshotStore(directory);
    this.restoreError = undefined;
    this.durableRunsById.clear();
    this.durableRestoreError = undefined;
    const loaded = this.durableStore.load();
    this.admissionTail = loaded.admissionTail;
    this.terminalRunIds.clear();
    if (loaded.errors.length > 0) {
      this.durableRestoreError = invalidDurableLoadMessage(loaded.errors[0]);
    }
    for (const snapshot of loaded.snapshots) {
      if (!isFusionRunState(snapshot.data)) {
        this.durableRestoreError ??= invalidDurableSnapshotMessage(snapshot);
        continue;
      }
      this.durableRunsById.set(snapshot.data.id, cloneRun(snapshot.data));
      if (snapshot.terminal) this.terminalRunIds.add(snapshot.data.id);
    }
    this.resetFromDurableRuns();
  }

  getDirectory(): string | undefined {
    return this.durableStore?.directory;
  }

  /**
   * Reloads project snapshots for a long-lived process. A disk record replaces
   * the cached record only when its persisted timestamp advances, so a stale
   * filesystem read cannot roll back a newer in-memory run.
   */
  refreshDurable(): void {
    if (!this.durableStore) return;
    const priorDurableError = this.durableRestoreError;
    const loaded = this.durableStore.load();
    this.admissionTail = loaded.admissionTail;
    const next = new Map<string, FusionRun>();
    let loadError =
      loaded.errors.length > 0
        ? invalidDurableLoadMessage(loaded.errors[0])
        : undefined;
    for (const snapshot of loaded.snapshots) {
      if (!isFusionRunState(snapshot.data)) {
        loadError ??= invalidDurableSnapshotMessage(snapshot);
        continue;
      }
      const previous =
        this.runsById.get(snapshot.data.id) ??
        this.durableRunsById.get(snapshot.data.id);
      if (snapshot.terminal) this.terminalRunIds.add(snapshot.data.id);
      if (snapshot.terminal || !previous || snapshot.data.updatedAt >= previous.updatedAt) {
        next.set(snapshot.data.id, cloneRun(snapshot.data));
      }
    }
    for (const [id, run] of this.durableRunsById) {
      if (!next.has(id)) next.set(id, run);
    }
    for (const [id, run] of this.runsById) {
      if (!next.has(id)) next.set(id, run);
    }
    if (loadError) {
      this.durableRestoreError = loadError;
      this.activeRun = undefined;
      this.lastRunSummary = undefined;
      this.runsById.clear();
      this.runIdsByOperationId.clear();
      return;
    }
    this.durableRestoreError = undefined;
    if (this.restoreError === priorDurableError) this.restoreError = undefined;
    this.durableRunsById = next;
    this.resetFromDurableRuns();
  }

  getActiveRun(): FusionRun | undefined {
    return this.activeRun ? cloneRun(this.activeRun) : undefined;
  }

  getLastRunSummary(): FusionRunSummary | undefined {
    return this.lastRunSummary
      ? cloneRunSummary(this.lastRunSummary)
      : undefined;
  }

  getRunById(id: string): FusionRun | undefined {
    const run = this.runsById.get(id);
    return run ? cloneRun(run) : undefined;
  }

  getRunByOperationId(operationId: string): FusionRun | undefined {
    const runId = this.runIdsByOperationId.get(operationId);
    return runId ? this.getRunById(runId) : undefined;
  }

  /** A corrupt newest snapshot must never revive an older active run. */
  getRestoreError(): string | undefined {
    return this.restoreError ?? this.durableRestoreError;
  }

  startRun(input: FusionRunStartInput): FusionRun {
    this.refreshDurable();
    const restoreError = this.getRestoreError();
    if (restoreError) {
      throw new FusionRunStoreError(
        `Cannot start a fusion run while restore is blocked: ${restoreError}`,
      );
    }
    if (this.activeRun) {
      throw new FusionRunStoreError(
        `Fusion run ${this.activeRun.id} is already active.`,
      );
    }
    if (
      input.operationId !== undefined &&
      this.runIdsByOperationId.has(input.operationId)
    ) {
      throw new FusionRunStoreError(
        `Fusion operation ${input.operationId} already has a run.`,
      );
    }
    const createdAt = input.createdAt ?? this.now();
    const run: FusionRun = {
      id: input.id ?? this.idFactory(),
      ...(input.spawnIntent ? { spawnIntent: cloneSpawnIntent(input.spawnIntent) } : {}),
      ...(input.reviewContext ? { reviewContext: { ...input.reviewContext } } : {}),
      ...(input.executionLifetime !== undefined
        ? { executionLifetime: cloneExecutionLifetime(input.executionLifetime) }
        : {}),
      ...(input.effectiveExecutionLifetime !== undefined
        ? {
            effectiveExecutionLifetime: cloneExecutionLifetime(
              input.effectiveExecutionLifetime,
            ),
          }
        : {}),
      ...(input.requestDigest !== undefined
        ? { requestDigest: input.requestDigest }
        : {}),
      ...(input.cancellationRequested !== undefined
        ? { cancellationRequested: input.cancellationRequested }
        : {}),
      ...(input.processTerminalProof !== undefined
        ? { processTerminalProof: cloneUnknown(input.processTerminalProof) }
        : {}),
      ...(input.observation !== undefined
        ? { observation: cloneUnknown(input.observation) }
        : {}),
      prompt: input.prompt,
      profileName: input.profileName,
      ...(input.inlinePanel?.length
        ? {
            inlinePanel: input.inlinePanel,
            ...(input.baseProfileName
              ? { baseProfileName: input.baseProfileName }
              : {}),
          }
        : {}),
      ...(input.operationId !== undefined
        ? { operationId: input.operationId }
        : {}),
      ...(input.outputContract !== undefined
        ? { outputContract: input.outputContract }
        : {}),
      ...(input.minimumSuccessfulPanelists !== undefined
        ? { minimumSuccessfulPanelists: input.minimumSuccessfulPanelists }
        : {}),
      ...(input.profileSnapshot !== undefined
        ? { profileSnapshot: cloneProfileSnapshot(input.profileSnapshot) }
        : {}),
      ...(input.timeoutOverrides !== undefined
        ? { timeoutOverrides: { ...input.timeoutOverrides } }
        : {}),
      ...(input.effectiveTimeouts !== undefined
        ? { effectiveTimeouts: { ...input.effectiveTimeouts } }
        : {}),
      phase: input.phase ?? "chain",
      createdAt,
      updatedAt: createdAt,
    };
    try {
      this.durableStore?.admit(run.id, cloneRun(run), this.admissionTail);
      this.persistRun(run, run, true);
    } catch (error: unknown) {
      this.refreshDurable();
      const active = this.getActiveRun();
      if (active && active.id !== run.id) throw new FusionRunStoreError(`Fusion run ${active.id} won shared admission.`, { cause: error });
      throw error;
    }
    this.activeRun = run;
    this.rememberRun(run);
    return cloneRun(run);
  }

  updateRun(id: string, patch: FusionRunPatch): FusionRun {
    const active = this.requireActiveRun(id);
    const updated = applyPatch(active, patch, patch.updatedAt ?? this.now());
    this.persistRun(updated);
    this.activeRun = updated;
    this.rememberRun(updated);
    return cloneRun(updated);
  }

  completeRun(id: string, patch: FusionRunTransitionPatch = {}): FusionRun {
    return this.transitionRun(id, "done", patch);
  }

  failRun(id: string, patch: FusionRunTransitionPatch = {}): FusionRun {
    return this.transitionRun(id, "failed", patch);
  }

  cancelRun(id: string, patch: FusionRunTransitionPatch = {}): FusionRun {
    return this.transitionRun(id, "cancelled", patch);
  }

  transitionRun(
    id: string,
    phase: FusionTerminalPhase,
    patch: FusionRunTransitionPatch = {},
  ): FusionRun {
    const active = this.requireActiveRun(id);
    let finished = applyTransitionPatch(
      active,
      phase,
      patch,
      patch.updatedAt ?? this.now(),
    );
    if (this.durableStore) {
      const terminal = this.durableStore.finish(id, cloneRun(finished));
      if (!isFusionRunState(terminal) || !isTerminalPhase(terminal.phase)) throw new FusionRunStoreError("Invalid immutable Fusion terminal state.");
      finished = { ...terminal, phase: terminal.phase };
      this.terminalRunIds.add(id);
    }
    const summary = toRunSummary(finished);
    this.persistRun(finished, summary);
    this.activeRun = undefined;
    this.lastRunSummary = summary;
    this.rememberRun(finished);
    return cloneRun(finished);
  }

  restoreFromEntries(
    entries: readonly unknown[],
  ): FusionRunSummary | undefined {
    this.restoreError = undefined;
    this.resetFromDurableRuns();

    if (this.durableRestoreError) {
      this.activeRun = undefined;
      this.lastRunSummary = undefined;
      this.runsById.clear();
      this.runIdsByOperationId.clear();
      this.restoreError = this.durableRestoreError;
      return undefined;
    }

    const latestPersisted = lastFusionRunEnvelope(entries);
    if (
      latestPersisted &&
      (!isFusionRunEntry(latestPersisted) || !isFusionRunState(latestPersisted.data))
    ) {
      // History readers may skip malformed entries, but restore must not adopt
      // an older active state after a newer snapshot was corrupted.
      this.activeRun = undefined;
      this.lastRunSummary = undefined;
      this.restoreError =
        "Latest persisted fusion run snapshot is invalid; refusing stale active-run recovery.";
      return undefined;
    }

    const states = readFusionRunStates(entries);
    for (const state of states) this.mergeRestoredRun(state);
    this.selectActiveRun();
    const summary = latestRunSummary(Array.from(this.runsById.values()));
    this.lastRunSummary = summary;
    return summary ? cloneRunSummary(summary) : undefined;
  }

  restoreFromSession(
    ctx: FusionRunSessionContext,
  ): FusionRunSummary | undefined {
    return this.restoreFromEntries(ctx.sessionManager.getEntries());
  }

  clearActiveRun(id?: string): void {
    if (!this.activeRun) return;
    if (id && this.activeRun.id !== id) {
      throw new FusionRunStoreError(
        `Fusion run ${id} is not active; active run is ${this.activeRun.id}.`,
      );
    }
    this.activeRun = undefined;
  }

  private persistRun(
    run: FusionRun,
    sessionEntry: FusionRun | FusionRunSummary = run,
    exclusive = false,
  ): void {
    this.durableStore?.write(run.id, cloneRun(run), exclusive);
    if (this.durableStore) {
      this.durableRunsById.set(run.id, cloneRun(run));
    }
    this.persistence?.appendEntry(
      FUSION_RUN_ENTRY_TYPE,
      cloneRunOrSummary(sessionEntry),
    );
  }

  private rememberRun(run: FusionRun): void {
    this.runsById.set(run.id, cloneRun(run));
    if (
      run.operationId !== undefined &&
      !this.runIdsByOperationId.has(run.operationId)
    ) {
      this.runIdsByOperationId.set(run.operationId, run.id);
    }
  }

  private resetFromDurableRuns(): void {
    this.runsById.clear();
    this.runIdsByOperationId.clear();
    this.activeRun = undefined;
    this.lastRunSummary = undefined;
    if (this.durableRestoreError) return;
    for (const run of this.durableRunsById.values()) {
      this.rememberRun(run);
    }
    this.selectActiveRun();
    this.lastRunSummary = latestRunSummary(Array.from(this.runsById.values()));
  }

  private mergeRestoredRun(run: FusionRun): void {
    if (this.terminalRunIds.has(run.id)) return;
    const existing = this.runsById.get(run.id);
    const isDurableBaseline = this.durableRunsById.has(run.id);
    if (
      !existing ||
      run.updatedAt > existing.updatedAt ||
      (!isDurableBaseline && run.updatedAt === existing.updatedAt)
    ) {
      this.rememberRun(run);
    }
  }

  private selectActiveRun(): void {
    if (this.restoreError === this.activeSelectionError) this.restoreError = undefined;
    this.activeSelectionError = undefined;
    const runs = Array.from(this.runsById.values());
    if (!this.durableStore) {
      const latest = latestRun(runs);
      this.activeRun = latest && !isTerminalPhase(latest.phase) ? cloneRun(latest) : undefined;
      return;
    }
    const active = runs.filter((run) => !isTerminalPhase(run.phase));
    if (active.length > 1) {
      this.activeSelectionError = `Multiple unfinished Fusion runs require recovery: ${active.map((run) => run.id).join(", ")}.`;
      this.restoreError = this.activeSelectionError;
      this.activeRun = undefined;
      return;
    }
    this.activeRun = active[0] ? cloneRun(active[0]) : undefined;
  }

  private requireActiveRun(id: string): FusionRun {
    if (!this.activeRun) {
      throw new FusionRunStoreError("No active fusion run.");
    }
    if (this.activeRun.id !== id) {
      throw new FusionRunStoreError(
        `Fusion run ${id} is not active; active run is ${this.activeRun.id}.`,
      );
    }
    return this.activeRun;
  }
}

export function readFusionRunStates(entries: readonly unknown[]): FusionRun[] {
  const states: FusionRun[] = [];
  for (const entry of entries) {
    if (!isFusionRunEntry(entry)) continue;
    if (isFusionRunState(entry.data)) states.push(cloneRun(entry.data));
  }
  return states;
}

export function readLastFusionRunState(
  entries: readonly unknown[],
): FusionRun | undefined {
  const states = readFusionRunStates(entries);
  const state = states.at(-1);
  return state ? cloneRun(state) : undefined;
}

export function readFusionRunSummaries(
  entries: readonly unknown[],
): FusionRunSummary[] {
  const summaries: FusionRunSummary[] = [];
  for (const entry of entries) {
    if (!isFusionRunEntry(entry)) continue;
    if (isFusionRunSummary(entry.data)) {
      summaries.push(cloneRunSummary(entry.data));
    }
  }
  return summaries;
}

export function readLastFusionRunSummary(
  entries: readonly unknown[],
): FusionRunSummary | undefined {
  const summaries = readFusionRunSummaries(entries);
  const summary = summaries.at(-1);
  return summary ? cloneRunSummary(summary) : undefined;
}

function applyPatch(
  run: FusionRun,
  patch: FusionRunPatch,
  updatedAt: number,
): FusionRun {
  const updated = cloneRun(run);
  updated.updatedAt = updatedAt;
  if (patch.executionLifetime !== undefined) {
    updated.executionLifetime = cloneExecutionLifetime(patch.executionLifetime);
  }
  if (patch.effectiveExecutionLifetime !== undefined) {
    updated.effectiveExecutionLifetime = cloneExecutionLifetime(
      patch.effectiveExecutionLifetime,
    );
  }
  if (patch.requestDigest !== undefined) updated.requestDigest = patch.requestDigest;
  if (patch.cancellationRequested !== undefined) {
    updated.cancellationRequested = patch.cancellationRequested;
  }
  if (patch.processTerminalProof !== undefined) {
    updated.processTerminalProof = cloneUnknown(patch.processTerminalProof);
  }
  if (patch.observation !== undefined) {
    updated.observation = cloneUnknown(patch.observation);
  }
  if (patch.phase !== undefined) updated.phase = patch.phase;
  if (patch.chainRunId !== undefined) updated.chainRunId = patch.chainRunId;
  if (patch.chainAsyncDir !== undefined) {
    updated.chainAsyncDir = patch.chainAsyncDir;
  }
  if (patch.panelRunId !== undefined) updated.panelRunId = patch.panelRunId;
  if (patch.panelAsyncDir !== undefined) {
    updated.panelAsyncDir = patch.panelAsyncDir;
  }
  if (patch.panelStopReason !== undefined) {
    updated.panelStopReason = patch.panelStopReason;
  }
  if (patch.panelStoppedIndices !== undefined) {
    updated.panelStoppedIndices = [...patch.panelStoppedIndices];
  }
  if (patch.panelDeadlines !== undefined) updated.panelDeadlines = patch.panelDeadlines.map((item) => ({ ...item }));
  if (patch.judgeRunId !== undefined) updated.judgeRunId = patch.judgeRunId;
  if (patch.judgeAsyncDir !== undefined) {
    updated.judgeAsyncDir = patch.judgeAsyncDir;
  }
  if (patch.judgeObservation !== undefined) {
    updated.judgeObservation = cloneObservation(patch.judgeObservation);
  }
  if (patch.completionQuality !== undefined) {
    updated.completionQuality = patch.completionQuality;
  }
  if (patch.panelOutputs !== undefined) {
    updated.panelOutputs = clonePanelOutputs(patch.panelOutputs);
  }
  if (patch.panelFailures !== undefined) {
    updated.panelFailures = clonePanelFailures(patch.panelFailures);
  }
  if (patch.recovery !== undefined) updated.recovery = cloneRecovery(patch.recovery);
  if (patch.spawnIntent === null) delete updated.spawnIntent;
  else if (patch.spawnIntent !== undefined) {
    updated.spawnIntent = cloneSpawnIntent(patch.spawnIntent);
  }
  if (patch.report !== undefined) updated.report = patch.report;
  if (patch.error !== undefined) updated.error = patch.error;
  return updated;
}

function applyTransitionPatch(
  run: FusionRun,
  phase: FusionTerminalPhase,
  patch: FusionRunTransitionPatch,
  updatedAt: number,
): FusionRun & { phase: FusionTerminalPhase } {
  const updated: FusionRun & { phase: FusionTerminalPhase } = {
    ...cloneRun(run),
    phase,
  };
  updated.updatedAt = updatedAt;
  if (patch.executionLifetime !== undefined) {
    updated.executionLifetime = cloneExecutionLifetime(patch.executionLifetime);
  }
  if (patch.effectiveExecutionLifetime !== undefined) {
    updated.effectiveExecutionLifetime = cloneExecutionLifetime(
      patch.effectiveExecutionLifetime,
    );
  }
  if (patch.requestDigest !== undefined) updated.requestDigest = patch.requestDigest;
  if (patch.cancellationRequested !== undefined) {
    updated.cancellationRequested = patch.cancellationRequested;
  }
  if (patch.processTerminalProof !== undefined) {
    updated.processTerminalProof = cloneUnknown(patch.processTerminalProof);
  }
  if (patch.observation !== undefined) {
    updated.observation = cloneUnknown(patch.observation);
  }
  if (patch.chainRunId !== undefined) updated.chainRunId = patch.chainRunId;
  if (patch.panelRunId !== undefined) updated.panelRunId = patch.panelRunId;
  if (patch.judgeRunId !== undefined) updated.judgeRunId = patch.judgeRunId;
  if (patch.recovery !== undefined) updated.recovery = cloneRecovery(patch.recovery);
  if (patch.spawnIntent !== undefined) {
    updated.spawnIntent = cloneSpawnIntent(patch.spawnIntent);
  }
  if (patch.report !== undefined) updated.report = patch.report;
  if (patch.error !== undefined) updated.error = patch.error;
  return updated;
}

function toRunSummary(
  run: FusionRun & { phase: FusionTerminalPhase },
): FusionRunSummary {
  return {
    id: run.id,
    ...(run.reviewContext ? { reviewContext: { ...run.reviewContext } } : {}),
    ...(run.executionLifetime !== undefined
      ? { executionLifetime: cloneExecutionLifetime(run.executionLifetime) }
      : {}),
    ...(run.effectiveExecutionLifetime !== undefined
      ? {
          effectiveExecutionLifetime: cloneExecutionLifetime(
            run.effectiveExecutionLifetime,
          ),
        }
      : {}),
    ...(run.requestDigest !== undefined
      ? { requestDigest: run.requestDigest }
      : {}),
    ...(run.cancellationRequested !== undefined
      ? { cancellationRequested: run.cancellationRequested }
      : {}),
    ...(run.processTerminalProof !== undefined
      ? { processTerminalProof: cloneUnknown(run.processTerminalProof) }
      : {}),
    ...(run.observation !== undefined
      ? { observation: cloneUnknown(run.observation) }
      : {}),
    prompt: run.prompt,
    profileName: run.profileName,
    ...(run.operationId !== undefined ? { operationId: run.operationId } : {}),
    ...(run.outputContract !== undefined
      ? { outputContract: run.outputContract }
      : {}),
    ...(run.completionQuality !== undefined
      ? { completionQuality: run.completionQuality }
      : {}),
    ...(run.effectiveTimeouts !== undefined
      ? { effectiveTimeouts: { ...run.effectiveTimeouts } }
      : {}),
    ...(run.recovery !== undefined ? { recovery: cloneRecovery(run.recovery) } : {}),
    phase: run.phase,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.chainRunId !== undefined ? { chainRunId: run.chainRunId } : {}),
    ...(run.panelRunId !== undefined ? { panelRunId: run.panelRunId } : {}),
    ...(run.judgeRunId !== undefined ? { judgeRunId: run.judgeRunId } : {}),
    ...(run.report !== undefined ? { report: run.report } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

function cloneRun(run: FusionRun): FusionRun {
  return {
    id: run.id,
    ...(run.reviewContext ? { reviewContext: { ...run.reviewContext } } : {}),
    ...(run.executionLifetime !== undefined
      ? { executionLifetime: cloneExecutionLifetime(run.executionLifetime) }
      : {}),
    ...(run.effectiveExecutionLifetime !== undefined
      ? {
          effectiveExecutionLifetime: cloneExecutionLifetime(
            run.effectiveExecutionLifetime,
          ),
        }
      : {}),
    ...(run.requestDigest !== undefined
      ? { requestDigest: run.requestDigest }
      : {}),
    ...(run.cancellationRequested !== undefined
      ? { cancellationRequested: run.cancellationRequested }
      : {}),
    ...(run.processTerminalProof !== undefined
      ? { processTerminalProof: cloneUnknown(run.processTerminalProof) }
      : {}),
    ...(run.observation !== undefined
      ? { observation: cloneUnknown(run.observation) }
      : {}),
    prompt: run.prompt,
    profileName: run.profileName,
    // cloneRun is a strict field allowlist: a new FusionRun field is dropped on
    // both write and read until it is listed here.
    ...(run.inlinePanel !== undefined
      ? { inlinePanel: [...run.inlinePanel] }
      : {}),
    ...(run.baseProfileName !== undefined
      ? { baseProfileName: run.baseProfileName }
      : {}),
    ...(run.operationId !== undefined ? { operationId: run.operationId } : {}),
    ...(run.outputContract !== undefined
      ? { outputContract: run.outputContract }
      : {}),
    ...(run.minimumSuccessfulPanelists !== undefined
      ? { minimumSuccessfulPanelists: run.minimumSuccessfulPanelists }
      : {}),
    ...(run.profileSnapshot !== undefined
      ? { profileSnapshot: cloneProfileSnapshot(run.profileSnapshot) }
      : {}),
    ...(run.timeoutOverrides !== undefined
      ? { timeoutOverrides: { ...run.timeoutOverrides } }
      : {}),
    ...(run.effectiveTimeouts !== undefined
      ? { effectiveTimeouts: { ...run.effectiveTimeouts } }
      : {}),
    ...(run.completionQuality !== undefined
      ? { completionQuality: run.completionQuality }
      : {}),
    phase: run.phase,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.chainRunId !== undefined ? { chainRunId: run.chainRunId } : {}),
    ...(run.chainAsyncDir !== undefined
      ? { chainAsyncDir: run.chainAsyncDir }
      : {}),
    ...(run.panelRunId !== undefined ? { panelRunId: run.panelRunId } : {}),
    ...(run.panelAsyncDir !== undefined
      ? { panelAsyncDir: run.panelAsyncDir }
      : {}),
    ...(run.panelStopReason !== undefined
      ? { panelStopReason: run.panelStopReason }
      : {}),
    ...(run.panelStoppedIndices !== undefined
      ? { panelStoppedIndices: [...run.panelStoppedIndices] }
      : {}),
    ...(run.panelDeadlines !== undefined
      ? { panelDeadlines: run.panelDeadlines.map((item) => ({ ...item })) }
      : {}),
    ...(run.judgeRunId !== undefined ? { judgeRunId: run.judgeRunId } : {}),
    ...(run.judgeAsyncDir !== undefined
      ? { judgeAsyncDir: run.judgeAsyncDir }
      : {}),
    ...(run.judgeObservation !== undefined
      ? { judgeObservation: cloneObservation(run.judgeObservation) }
      : {}),
    ...(run.panelOutputs !== undefined
      ? { panelOutputs: clonePanelOutputs(run.panelOutputs) }
      : {}),
    ...(run.panelFailures !== undefined
      ? { panelFailures: clonePanelFailures(run.panelFailures) }
      : {}),
    ...(run.recovery !== undefined ? { recovery: cloneRecovery(run.recovery) } : {}),
    ...(run.spawnIntent !== undefined
      ? { spawnIntent: cloneSpawnIntent(run.spawnIntent) }
      : {}),
    ...(run.report !== undefined ? { report: run.report } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

function cloneRunSummary(summary: FusionRunSummary): FusionRunSummary {
  return toRunSummary(summary);
}

function cloneRunOrSummary(
  value: FusionRun | FusionRunSummary,
): FusionRun | FusionRunSummary {
  return isTerminalRun(value) ? cloneRunSummary(value) : cloneRun(value);
}

function cloneExecutionLifetime(lifetime: ExecutionLifetime): ExecutionLifetime {
  return lifetime.mode === "bounded"
    ? { mode: "bounded", timeoutMs: lifetime.timeoutMs }
    : { mode: "unbounded" };
}

function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneUnknown(item));
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      clone[key] = cloneUnknown(item);
    }
    return clone;
  }
  return value;
}

function latestRun(runs: readonly FusionRun[]): FusionRun | undefined {
  let latest: FusionRun | undefined;
  for (const run of runs) {
    if (latest === undefined || run.updatedAt >= latest.updatedAt) latest = run;
  }
  return latest;
}

function latestRunSummary(
  runs: readonly FusionRun[],
): FusionRunSummary | undefined {
  let latest: (FusionRun & { phase: FusionTerminalPhase }) | undefined;
  for (const run of runs) {
    if (!isTerminalRunState(run)) continue;
    if (latest === undefined || run.updatedAt >= latest.updatedAt) latest = run;
  }
  return latest ? toRunSummary(latest) : undefined;
}

function isTerminalRun(
  value: FusionRun | FusionRunSummary,
): value is FusionRunSummary {
  return isTerminalPhase(value.phase);
}

function isTerminalRunState(
  value: FusionRun,
): value is FusionRun & { phase: FusionTerminalPhase } {
  return isTerminalPhase(value.phase);
}

function invalidDurableSnapshotMessage(snapshot: DurableRunSnapshot): string {
  return `Latest persisted fusion run snapshot is invalid; refusing stale project-run recovery (${snapshot.fileName}).`;
}

function invalidDurableLoadMessage(error: string | undefined): string {
  return `Latest persisted fusion run snapshot is invalid; refusing stale project-run recovery${error ? ` (${error})` : "."}`;
}

function lastFusionRunEnvelope(entries: readonly unknown[]): unknown {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    // Locate the newest entry by its envelope before inspecting data. A
    // malformed data field (or its absence) must not revive an older run.
    if (isFusionRunEnvelope(entry)) return entry;
  }
  return undefined;
}

function isFusionRunEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === "custom" &&
    value.customType === FUSION_RUN_ENTRY_TYPE
  );
}

function isFusionRunEntry(
  value: unknown,
): value is { type: "custom"; customType: string; data: unknown } {
  return isFusionRunEnvelope(value) && "data" in value;
}

function isFusionRunState(value: unknown): value is FusionRun {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (typeof value.prompt !== "string") return false;
  if (!isNonEmptyString(value.profileName)) return false;
  if (value.reviewContext !== undefined && !isReviewContext(value.reviewContext)) return false;
  if (
    value.executionLifetime !== undefined &&
    !isExecutionLifetime(value.executionLifetime)
  ) {
    return false;
  }
  if (
    value.effectiveExecutionLifetime !== undefined &&
    !isExecutionLifetime(value.effectiveExecutionLifetime)
  ) {
    return false;
  }
  if (
    value.requestDigest !== undefined &&
    !isNonEmptyString(value.requestDigest)
  ) {
    return false;
  }
  if (
    value.cancellationRequested !== undefined &&
    typeof value.cancellationRequested !== "boolean"
  ) {
    return false;
  }
  if (value.operationId !== undefined && !isNonEmptyString(value.operationId)) {
    return false;
  }
  if (
    value.outputContract !== undefined &&
    value.outputContract !== "plan-review-v1"
  ) {
    return false;
  }
  if (
    value.minimumSuccessfulPanelists !== undefined &&
    value.minimumSuccessfulPanelists !== "majority" &&
    value.minimumSuccessfulPanelists !== "all" &&
    (!isFiniteNumber(value.minimumSuccessfulPanelists) ||
      !Number.isInteger(value.minimumSuccessfulPanelists) ||
      value.minimumSuccessfulPanelists < 1)
  ) {
    return false;
  }
  if (
    value.profileSnapshot !== undefined &&
    !isProfileSnapshot(value.profileSnapshot)
  ) {
    return false;
  }
  // Snapshots are the canonical quorum record for new runs. Older records may
  // also carry the run-level policy, but it must resolve to the same quorum.
  if (
    value.profileSnapshot !== undefined &&
    value.minimumSuccessfulPanelists !== undefined &&
    resolvePersistedQuorum(
      value.minimumSuccessfulPanelists,
      value.profileSnapshot.panel.length,
    ) !== value.profileSnapshot.minimumSuccessfulPanelists
  ) {
    return false;
  }
  if (value.timeoutOverrides !== undefined && !isTimeoutOverrides(value.timeoutOverrides)) {
    return false;
  }
  if (value.effectiveTimeouts !== undefined && !isEffectiveTimeouts(value.effectiveTimeouts)) {
    return false;
  }
  if (
    value.completionQuality !== undefined &&
    value.completionQuality !== "complete" &&
    value.completionQuality !== "partial"
  ) {
    return false;
  }
  if (
    value.inlinePanel !== undefined &&
    (!Array.isArray(value.inlinePanel) ||
      !value.inlinePanel.every(isNonEmptyString))
  ) {
    return false;
  }
  if (
    value.baseProfileName !== undefined &&
    !isNonEmptyString(value.baseProfileName)
  ) {
    return false;
  }
  if (!isFusionPhase(value.phase)) return false;
  if (!isFiniteNumber(value.createdAt)) return false;
  if (!isFiniteNumber(value.updatedAt)) return false;
  if (value.chainRunId !== undefined && typeof value.chainRunId !== "string") {
    return false;
  }
  if (
    value.chainAsyncDir !== undefined &&
    typeof value.chainAsyncDir !== "string"
  ) {
    return false;
  }
  if (value.panelRunId !== undefined && typeof value.panelRunId !== "string") {
    return false;
  }
  if (
    value.panelAsyncDir !== undefined &&
    typeof value.panelAsyncDir !== "string"
  ) {
    return false;
  }
  if (
    value.panelStopReason !== undefined &&
    value.panelStopReason !== "agreement"
  ) {
    return false;
  }
  if (
    value.panelStoppedIndices !== undefined &&
    (!Array.isArray(value.panelStoppedIndices) ||
      !value.panelStoppedIndices.every(
        (index: unknown) =>
          typeof index === "number" && Number.isInteger(index) && index >= 0,
      ))
  ) {
    return false;
  }
  if (value.panelDeadlines !== undefined && !isPanelDeadlines(value.panelDeadlines)) return false;
  if (value.judgeRunId !== undefined && typeof value.judgeRunId !== "string") {
    return false;
  }
  if (
    value.judgeAsyncDir !== undefined &&
    typeof value.judgeAsyncDir !== "string"
  ) {
    return false;
  }
  if (
    value.judgeObservation !== undefined &&
    !isRunObservation(value.judgeObservation)
  ) {
    return false;
  }
  if (
    value.panelOutputs !== undefined &&
    !isPanelOutputArray(value.panelOutputs)
  ) {
    return false;
  }
  if (
    value.panelFailures !== undefined &&
    !isPanelFailureArray(value.panelFailures)
  ) {
    return false;
  }
  if (value.recovery !== undefined && !isRecoveryState(value.recovery)) {
    return false;
  }
  if (value.spawnIntent !== undefined && !isSpawnIntent(value.spawnIntent)) {
    return false;
  }
  if (value.report !== undefined && typeof value.report !== "string") {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    return false;
  }
  return (
    value.profileSnapshot === undefined ||
    validateFusionRunPanelSlots(value, value.profileSnapshot.panel.length) ===
      undefined
  );
}

function isFusionRunSummary(value: unknown): value is FusionRunSummary {
  return isFusionRunState(value) && isTerminalPhase(value.phase);
}

function isPanelDeadlines(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const slots = new Set<number>();
  const children = new Set<string>();
  return value.every((item: unknown) => {
    if (!isRecord(item) || !isPanelSlotIndex(item.index) || !isNonEmptyString(item.childRunId) ||
      !isFiniteNumber(item.requestedAt) || !isFiniteNumber(item.finalizeAt) || !isFiniteNumber(item.hardDeadlineAt) ||
      item.finalizeAt >= item.hardDeadlineAt ||
      !["pending", "continued", "finishing"].includes(String(item.status)) ||
      (item.deliveryError !== undefined && typeof item.deliveryError !== "string") ||
      slots.has(item.index) || children.has(item.childRunId)) return false;
    slots.add(item.index);
    children.add(item.childRunId);
    return true;
  });
}

function isTimeoutOverrides(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    value.panelistSoftTimeoutMs,
    value.panelistTimeoutMs,
    value.panelTimeoutMs,
    value.panelGraceMs,
    value.judgeTimeoutMs,
  ].every((timeout) => timeout === undefined || (isFiniteNumber(timeout) && Number.isInteger(timeout) && timeout > 0));
}

function isEffectiveTimeouts(value: unknown): boolean {
  return (
    isTimeoutOverrides(value) &&
    isRecord(value) &&
    isFiniteNumber(value.panelistTimeoutMs) &&
    isFiniteNumber(value.panelTimeoutMs) &&
    isFiniteNumber(value.panelGraceMs) &&
    isFiniteNumber(value.judgeTimeoutMs) &&
    typeof value.usesLegacyTimeout === "boolean"
  );
}

function isFusionPhase(value: unknown): value is FusionPhase {
  return (
    value === "panel" ||
    value === "chain" ||
    value === "judge" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isExecutionLifetime(value: unknown): value is ExecutionLifetime {
  if (!isRecord(value)) return false;
  if (value.mode === "unbounded") return value.timeoutMs === undefined;
  return (
    value.mode === "bounded" &&
    isFiniteNumber(value.timeoutMs) &&
    Number.isSafeInteger(value.timeoutMs) &&
    value.timeoutMs > 0
  );
}

function isTerminalPhase(value: unknown): value is FusionTerminalPhase {
  return value === "done" || value === "failed" || value === "cancelled";
}

/**
 * Checks persisted slot references before they are restored or merged. Legacy
 * runs omit a profile snapshot, so their caller supplies the safely resolved
 * profile length during restore.
 */
export function validateFusionRunPanelSlots(
  run: Pick<
    FusionRun,
    "panelOutputs" | "panelFailures" | "panelStoppedIndices" | "panelDeadlines" | "recovery"
  >,
  panelLength: number,
): string | undefined {
  const slotGroups: ReadonlyArray<readonly number[] | undefined> = [
    run.panelOutputs?.map((output) => output.index),
    run.panelFailures?.map((failure) => failure.index),
    run.panelStoppedIndices,
    run.panelDeadlines?.map((item) => item.index),
    run.recovery?.failedPanelIndices,
  ];
  for (const slots of slotGroups) {
    for (const slot of slots ?? []) {
      if (!isPanelSlotIndex(slot) || slot >= panelLength) {
        return `Persisted panel slot ${String(slot)} is outside the configured panel.`;
      }
    }
  }
  return undefined;
}

function resolvePersistedQuorum(
  policy: NonNullable<FusionRun["minimumSuccessfulPanelists"]>,
  panelLength: number,
): number {
  if (policy === "all") return panelLength;
  if (typeof policy === "number") {
    return panelLength > 1 ? Math.max(2, Math.min(policy, panelLength)) : 1;
  }
  return Math.ceil(panelLength / 2);
}

function isPanelOutputArray(
  value: unknown,
): value is NonNullable<FusionRun["panelOutputs"]> {
  return Array.isArray(value) && value.every(isPanelOutput);
}

function isPanelOutput(
  value: unknown,
): value is NonNullable<FusionRun["panelOutputs"]>[number] {
  return (
    isRecord(value) &&
    isPanelSlotIndex(value.index) &&
    isNonEmptyString(value.agent) &&
    typeof value.output === "string" &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.configuredModel === undefined ||
      typeof value.configuredModel === "string") &&
    (value.artifactPath === undefined ||
      typeof value.artifactPath === "string") &&
    (value.sessionPath === undefined ||
      typeof value.sessionPath === "string") &&
    (value.decision === undefined || isPanelDecision(value.decision)) &&
    (value.observation === undefined || isRunObservation(value.observation))
  );
}

function isPanelFailureArray(
  value: unknown,
): value is NonNullable<FusionRun["panelFailures"]> {
  return Array.isArray(value) && value.every(isPanelFailure);
}

function isPanelFailure(
  value: unknown,
): value is NonNullable<FusionRun["panelFailures"]>[number] {
  return (
    isRecord(value) &&
    isPanelSlotIndex(value.index) &&
    isNonEmptyString(value.agent) &&
    typeof value.summary === "string" &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.configuredModel === undefined ||
      typeof value.configuredModel === "string") &&
    (value.artifactPath === undefined ||
      typeof value.artifactPath === "string") &&
    (value.sessionPath === undefined ||
      typeof value.sessionPath === "string") &&
    (value.reason === undefined || isPanelFailureReason(value.reason)) &&
    (value.observation === undefined || isRunObservation(value.observation))
  );
}

function isProfileSnapshot(value: unknown): value is FusionProfileSnapshot {
  if (!isRecord(value) || !Array.isArray(value.panel) || value.panel.length === 0) {
    return false;
  }
  if (!value.panel.every(isSnapshotPanelMember) || !isSnapshotJudge(value.judge)) {
    return false;
  }
  if (
    !isFiniteNumber(value.minimumSuccessfulPanelists) ||
    !Number.isInteger(value.minimumSuccessfulPanelists) ||
    value.minimumSuccessfulPanelists < 1 ||
    value.minimumSuccessfulPanelists > value.panel.length
  ) {
    return false;
  }
  if (value.context !== undefined && value.context !== "fresh" && value.context !== "fork") {
    return false;
  }
  if (value.stopWhenPanelAgrees !== undefined && typeof value.stopWhenPanelAgrees !== "boolean") {
    return false;
  }
  if (value.blindPanelLabels !== undefined && typeof value.blindPanelLabels !== "boolean") {
    return false;
  }
  if (value.synthesis !== undefined && value.synthesis !== "select" && value.synthesis !== "merge") {
    return false;
  }
  return value.judgeToolBudget === undefined || isSnapshotToolBudget(value.judgeToolBudget);
}

function isSnapshotPanelMember(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isSnapshotAgent(value.agent)) {
    return false;
  }
  return (
    (value.label === undefined || isNonEmptyString(value.label)) &&
    (value.model === undefined || isNonEmptyString(value.model)) &&
    (value.thinking === undefined || isThinkingLevel(value.thinking)) &&
    (value.role === undefined || typeof value.role === "string") &&
    (value.question === undefined || isNonEmptyString(value.question))
  );
}

function isSnapshotJudge(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSnapshotAgent(value.agent) &&
    (value.model === undefined || isNonEmptyString(value.model)) &&
    (value.thinking === undefined || isThinkingLevel(value.thinking))
  );
}

function isSnapshotAgent(value: unknown): boolean {
  return (
    isNonEmptyString(value) &&
    /^[^\s.]+(?:\.[^\s.]+)*$/.test(value.trim())
  );
}

function isThinkingLevel(value: unknown): boolean {
  return value === "off" || value === "minimal" || value === "low" ||
    value === "medium" || value === "high" || value === "xhigh";
}

function isSnapshotToolBudget(value: unknown): boolean {
  if (!isRecord(value) || (value.soft === undefined && value.hard === undefined)) {
    return false;
  }
  if (value.soft !== undefined && (!isFiniteNumber(value.soft) || !Number.isInteger(value.soft) || value.soft < 1)) {
    return false;
  }
  if (value.hard !== undefined && (!isFiniteNumber(value.hard) || !Number.isInteger(value.hard) || value.hard < 1)) {
    return false;
  }
  if (typeof value.soft === "number" && typeof value.hard === "number" && value.soft > value.hard) {
    return false;
  }
  return value.block === undefined || value.block === "*" ||
    (Array.isArray(value.block) && value.block.length > 0 && value.block.every(isNonEmptyString));
}

function cloneProfileSnapshot(snapshot: FusionProfileSnapshot): FusionProfileSnapshot {
  return {
    panel: snapshot.panel.map((member) => ({ ...member })),
    judge: { ...snapshot.judge },
    minimumSuccessfulPanelists: snapshot.minimumSuccessfulPanelists,
    ...(snapshot.context !== undefined ? { context: snapshot.context } : {}),
    ...(snapshot.stopWhenPanelAgrees !== undefined
      ? { stopWhenPanelAgrees: snapshot.stopWhenPanelAgrees }
      : {}),
    ...(snapshot.blindPanelLabels !== undefined
      ? { blindPanelLabels: snapshot.blindPanelLabels }
      : {}),
    ...(snapshot.judgeToolBudget !== undefined
      ? {
          judgeToolBudget: {
            ...snapshot.judgeToolBudget,
            ...(Array.isArray(snapshot.judgeToolBudget.block)
              ? { block: [...snapshot.judgeToolBudget.block] }
              : {}),
          },
        }
      : {}),
    ...(snapshot.synthesis !== undefined ? { synthesis: snapshot.synthesis } : {}),
  };
}

function isRecoveryState(value: unknown): value is FusionRecoveryState {
  return (
    isRecord(value) &&
    value.retryDeferred === true &&
    Array.isArray(value.failedPanelIndices) &&
    value.failedPanelIndices.every(isPanelSlotIndex)
  );
}

function isPanelSlotIndex(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function cloneRecovery(recovery: FusionRecoveryState): FusionRecoveryState {
  return { ...recovery, failedPanelIndices: [...recovery.failedPanelIndices] };
}

function isSpawnIntent(value: unknown): value is FusionRun["spawnIntent"] {
  return (
    isRecord(value) &&
    (value.stage === "panel" || value.stage === "judge") &&
    isFiniteNumber(value.requestedAt) &&
    (value.requestId === undefined || isNonEmptyString(value.requestId)) &&
    (value.requestDigest === undefined || isNonEmptyString(value.requestDigest)) &&
    (value.params === undefined || isRecord(value.params))
  );
}

function cloneSpawnIntent(
  intent: NonNullable<FusionRun["spawnIntent"]>,
): NonNullable<FusionRun["spawnIntent"]> {
  return {
    stage: intent.stage,
    requestedAt: intent.requestedAt,
    ...(intent.requestId !== undefined ? { requestId: intent.requestId } : {}),
    ...(intent.requestDigest !== undefined
      ? { requestDigest: intent.requestDigest }
      : {}),
    ...(intent.params !== undefined
      ? { params: cloneObject(intent.params) }
      : {}),
  };
}

function cloneObject(value: object): object {
  const cloned = cloneUnknown(value);
  return typeof cloned === "object" && cloned !== null ? cloned : {};
}

function clonePanelOutputs(
  outputs: NonNullable<FusionRun["panelOutputs"]>,
): NonNullable<FusionRun["panelOutputs"]> {
  return outputs.map((output) => ({
    ...output,
    ...(output.decision
      ? { decision: clonePanelDecision(output.decision) }
      : {}),
    ...(output.observation
      ? { observation: cloneObservation(output.observation) }
      : {}),
  }));
}

function clonePanelFailures(
  failures: NonNullable<FusionRun["panelFailures"]>,
): NonNullable<FusionRun["panelFailures"]> {
  return failures.map((failure) => ({
    ...failure,
    ...(failure.observation
      ? { observation: cloneObservation(failure.observation) }
      : {}),
  }));
}

function cloneObservation(observation: RunObservation): RunObservation {
  return {
    ...(observation.model ? { model: observation.model } : {}),
    ...(observation.durationMs !== undefined
      ? { durationMs: observation.durationMs }
      : {}),
    ...(observation.usage ? { usage: { ...observation.usage } } : {}),
    ...(observation.attempts
      ? { attempts: observation.attempts.map((attempt) => ({ ...attempt })) }
      : {}),
    ...(observation.providerFailures
      ? {
          providerFailures: observation.providerFailures.map((failure) => ({
            ...failure,
          })),
        }
      : {}),
  };
}

function clonePanelDecision(decision: PanelDecision): PanelDecision {
  return { ...decision };
}

function isRunObservation(value: unknown): value is RunObservation {
  if (!isRecord(value)) return false;
  if (value.model !== undefined && typeof value.model !== "string")
    return false;
  if (value.durationMs !== undefined && !isFiniteNumber(value.durationMs)) {
    return false;
  }
  if (value.usage !== undefined && !isRunUsage(value.usage)) return false;
  if (value.attempts !== undefined && !isModelAttemptArray(value.attempts)) {
    return false;
  }
  return (
    value.providerFailures === undefined ||
    (Array.isArray(value.providerFailures) &&
      value.providerFailures.every(isProviderFailure))
  );
}

function isRunUsage(value: unknown): value is RunUsage {
  if (!isRecord(value)) return false;
  return (
    (value.inputTokens === undefined || isFiniteNumber(value.inputTokens)) &&
    (value.outputTokens === undefined || isFiniteNumber(value.outputTokens)) &&
    (value.costUsd === undefined || isFiniteNumber(value.costUsd))
  );
}

function isModelAttemptArray(value: unknown): value is ModelAttempt[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!isRecord(item)) return false;
      return (
        typeof item.model === "string" &&
        typeof item.success === "boolean" &&
        (item.error === undefined || typeof item.error === "string")
      );
    })
  );
}

function isProviderFailure(value: unknown): value is ProviderFailure {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === "string" &&
    typeof value.message === "string" &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.count === undefined || isFiniteNumber(value.count))
  );
}

function isPanelDecision(value: unknown): value is PanelDecision {
  if (!isRecord(value)) return false;
  return (
    typeof value.recommendation === "string" &&
    (value.confidence === "low" ||
      value.confidence === "medium" ||
      value.confidence === "high") &&
    typeof value.needsMoreEvidence === "boolean" &&
    typeof value.answerMarkdown === "string"
  );
}

function isPanelFailureReason(value: unknown): boolean {
  return (
    value === "provider" ||
    value === "timeout" ||
    value === "interrupted" ||
    value === "stopped-after-agreement"
  );
}
