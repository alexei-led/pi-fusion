import { randomUUID } from "node:crypto";
import type { FusionPhase, FusionRun } from "./types.js";

export const FUSION_RUN_ENTRY_TYPE = "fusion-run";

export type FusionTerminalPhase = Extract<
  FusionPhase,
  "done" | "failed" | "cancelled"
>;

export type FusionRunSummary = Omit<
  Pick<
    FusionRun,
    | "id"
    | "prompt"
    | "profileName"
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
  prompt: string;
  profileName: string;
  phase?: Exclude<FusionPhase, FusionTerminalPhase>;
  createdAt?: number;
}

export interface FusionRunPatch {
  phase?: Exclude<FusionPhase, FusionTerminalPhase>;
  chainRunId?: string;
  chainAsyncDir?: string;
  panelRunId?: string;
  judgeRunId?: string;
  judgeAsyncDir?: string;
  panelOutputs?: FusionRun["panelOutputs"];
  panelFailures?: FusionRun["panelFailures"];
  report?: string;
  error?: string;
  updatedAt?: number;
}

export interface FusionRunTransitionPatch {
  chainRunId?: string;
  panelRunId?: string;
  judgeRunId?: string;
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
}

export class FusionRunStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionRunStoreError";
  }
}

export class FusionRunStore {
  private activeRun: FusionRun | undefined;
  private lastRunSummary: FusionRunSummary | undefined;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly persistence: FusionRunStorePersistence | undefined;

  constructor(options: FusionRunStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.persistence = options.persistence;
  }

  getActiveRun(): FusionRun | undefined {
    return this.activeRun ? cloneRun(this.activeRun) : undefined;
  }

  getLastRunSummary(): FusionRunSummary | undefined {
    return this.lastRunSummary
      ? cloneRunSummary(this.lastRunSummary)
      : undefined;
  }

  startRun(input: FusionRunStartInput): FusionRun {
    if (this.activeRun) {
      throw new FusionRunStoreError(
        `Fusion run ${this.activeRun.id} is already active.`,
      );
    }
    const createdAt = input.createdAt ?? this.now();
    const run: FusionRun = {
      id: input.id ?? this.idFactory(),
      prompt: input.prompt,
      profileName: input.profileName,
      phase: input.phase ?? "chain",
      createdAt,
      updatedAt: createdAt,
    };
    this.activeRun = run;
    this.persistRun(run);
    return cloneRun(run);
  }

  updateRun(id: string, patch: FusionRunPatch): FusionRun {
    const active = this.requireActiveRun(id);
    const updated = applyPatch(active, patch, patch.updatedAt ?? this.now());
    this.activeRun = updated;
    this.persistRun(updated);
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
    const finished = applyTransitionPatch(
      active,
      phase,
      patch,
      patch.updatedAt ?? this.now(),
    );
    const summary = toRunSummary(finished);
    this.activeRun = undefined;
    this.lastRunSummary = summary;
    this.persistRun(summary);
    return cloneRun(finished);
  }

  restoreFromEntries(
    entries: readonly unknown[],
  ): FusionRunSummary | undefined {
    const latestState = readLastFusionRunState(entries);
    const summary = readLastFusionRunSummary(entries);
    this.activeRun =
      latestState && !isTerminalPhase(latestState.phase)
        ? cloneRun(latestState)
        : undefined;
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

  private persistRun(run: FusionRun): void {
    this.persistence?.appendEntry(FUSION_RUN_ENTRY_TYPE, cloneRun(run));
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
  if (patch.phase !== undefined) updated.phase = patch.phase;
  if (patch.chainRunId !== undefined) updated.chainRunId = patch.chainRunId;
  if (patch.chainAsyncDir !== undefined) {
    updated.chainAsyncDir = patch.chainAsyncDir;
  }
  if (patch.panelRunId !== undefined) updated.panelRunId = patch.panelRunId;
  if (patch.judgeRunId !== undefined) updated.judgeRunId = patch.judgeRunId;
  if (patch.judgeAsyncDir !== undefined) {
    updated.judgeAsyncDir = patch.judgeAsyncDir;
  }
  if (patch.panelOutputs !== undefined) {
    updated.panelOutputs = clonePanelOutputs(patch.panelOutputs);
  }
  if (patch.panelFailures !== undefined) {
    updated.panelFailures = clonePanelFailures(patch.panelFailures);
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
  if (patch.chainRunId !== undefined) updated.chainRunId = patch.chainRunId;
  if (patch.panelRunId !== undefined) updated.panelRunId = patch.panelRunId;
  if (patch.judgeRunId !== undefined) updated.judgeRunId = patch.judgeRunId;
  if (patch.report !== undefined) updated.report = patch.report;
  if (patch.error !== undefined) updated.error = patch.error;
  return updated;
}

function toRunSummary(
  run: FusionRun & { phase: FusionTerminalPhase },
): FusionRunSummary {
  return {
    id: run.id,
    prompt: run.prompt,
    profileName: run.profileName,
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
    prompt: run.prompt,
    profileName: run.profileName,
    phase: run.phase,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.chainRunId !== undefined ? { chainRunId: run.chainRunId } : {}),
    ...(run.chainAsyncDir !== undefined
      ? { chainAsyncDir: run.chainAsyncDir }
      : {}),
    ...(run.panelRunId !== undefined ? { panelRunId: run.panelRunId } : {}),
    ...(run.judgeRunId !== undefined ? { judgeRunId: run.judgeRunId } : {}),
    ...(run.judgeAsyncDir !== undefined
      ? { judgeAsyncDir: run.judgeAsyncDir }
      : {}),
    ...(run.panelOutputs !== undefined
      ? { panelOutputs: clonePanelOutputs(run.panelOutputs) }
      : {}),
    ...(run.panelFailures !== undefined
      ? { panelFailures: clonePanelFailures(run.panelFailures) }
      : {}),
    ...(run.report !== undefined ? { report: run.report } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

function cloneRunSummary(summary: FusionRunSummary): FusionRunSummary {
  return toRunSummary(summary);
}

function isFusionRunEntry(
  value: unknown,
): value is { type: "custom"; customType: string; data: unknown } {
  return (
    isRecord(value) &&
    value.type === "custom" &&
    value.customType === FUSION_RUN_ENTRY_TYPE &&
    "data" in value
  );
}

function isFusionRunState(value: unknown): value is FusionRun {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (typeof value.prompt !== "string") return false;
  if (!isNonEmptyString(value.profileName)) return false;
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
  if (value.report !== undefined && typeof value.report !== "string") {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    return false;
  }
  return true;
}

function isFusionRunSummary(value: unknown): value is FusionRunSummary {
  return isFusionRunState(value) && isTerminalPhase(value.phase);
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

function isTerminalPhase(value: unknown): value is FusionTerminalPhase {
  return value === "done" || value === "failed" || value === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    isFiniteNumber(value.index) &&
    isNonEmptyString(value.agent) &&
    typeof value.output === "string" &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.artifactPath === undefined ||
      typeof value.artifactPath === "string") &&
    (value.sessionPath === undefined || typeof value.sessionPath === "string")
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
    isFiniteNumber(value.index) &&
    isNonEmptyString(value.agent) &&
    typeof value.summary === "string" &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.artifactPath === undefined ||
      typeof value.artifactPath === "string") &&
    (value.sessionPath === undefined || typeof value.sessionPath === "string")
  );
}

function clonePanelOutputs(
  outputs: NonNullable<FusionRun["panelOutputs"]>,
): NonNullable<FusionRun["panelOutputs"]> {
  return outputs.map((output) => ({ ...output }));
}

function clonePanelFailures(
  failures: NonNullable<FusionRun["panelFailures"]>,
): NonNullable<FusionRun["panelFailures"]> {
  return failures.map((failure) => ({ ...failure }));
}
