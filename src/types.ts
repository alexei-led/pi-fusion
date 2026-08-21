export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const PANEL_AGENT = "pi-fusion.fusion-panelist";
export const PANEL_AGENT_WEB = "pi-fusion.fusion-panelist-web";
export const PANEL_AGENT_FULL = "pi-fusion.fusion-panelist-full";
export const JUDGE_AGENT = "pi-fusion.fusion-judge";
export const COMPOSER_AGENT = "pi-fusion.fusion-composer";

export type FusionContextMode = "fresh" | "fork";
export type CallerOutputContract = "plan-review-v1";

/**
 * How panel answers become one report.
 * `select` — panelists answered the same question; the judge picks or reconciles.
 * `merge`  — panelists answered different facets; the composer unions them.
 */
export type FusionSynthesisMode = "select" | "merge";

export interface PanelMemberConfig {
  id: string;
  /** Report label. Defaults to `id` — set it only when they should differ. */
  label?: string;
  agent: string;
  model?: string;
  thinking?: ThinkingLevel;
  role?: string;
  /**
   * Facet prompt sent instead of the raw task. `{task}` is substituted with the
   * original prompt. Turns a redundant panel into one that divides the work.
   */
  question?: string;
}

export interface JudgeConfig {
  agent: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export type MinimumSuccessfulPanelists = "majority" | "all" | number;

/** Per-run deadline overrides accepted by CLI, tool, and RPC starts. */
export interface FusionTimeoutOverrides {
  panelistTimeoutMs?: number;
  panelTimeoutMs?: number;
  panelGraceMs?: number;
  judgeTimeoutMs?: number;
}

export interface EffectiveFusionTimeouts {
  panelistTimeoutMs: number;
  panelTimeoutMs: number;
  panelGraceMs: number;
  judgeTimeoutMs: number;
  /** True when the legacy shared timeout supplied one or more deadline values. */
  usesLegacyTimeout: boolean;
}

export interface FusionProfile {
  panel: PanelMemberConfig[];
  judge: JudgeConfig;
  concurrency?: number;
  /** Legacy shared wall-clock timeout used when a stage timeout is absent. */
  timeoutMs?: number;
  /** Per-child deadline. It is capped below the enclosing panel deadline. */
  panelistTimeoutMs?: number;
  /** Wall-clock timeout for the complete panel workflow. */
  panelTimeoutMs?: number;
  /** Time reserved between child and enclosing panel deadlines. */
  panelGraceMs?: number;
  /** Wall-clock timeout for the synthesis workflow. */
  judgeTimeoutMs?: number;
  /** Successful panel outputs required for synthesis. Defaults to a majority. */
  minimumSuccessfulPanelists?: MinimumSuccessfulPanelists;
  context?: FusionContextMode;
  stopWhenPanelAgrees?: boolean;
  /**
   * Present panel answers to the judge as "Candidate A/B/C" instead of the
   * configured labels. Role names read as authority cues before a word of
   * content is compared. The report always restores the real labels.
   */
  blindPanelLabels?: boolean;
  /**
   * Caps each panelist's tool calls. `soft` nudges; `hard` blocks further tool
   * use so the panelist still finalises before the workflow timeout.
   */
  panelToolBudget?: ToolBudget;
  /**
   * Caps the tool calls the judge may spend verifying contested claims.
   * `soft` nudges, `hard` blocks further tool use so the judge still finalises.
   */
  judgeToolBudget?: ToolBudget;
  /**
   * Usually omit this. It is inferred: a panel where any member has a
   * `question` is answering facets, so it merges; otherwise it selects.
   * Set it only to override that — most often `"select"` on a faceted panel
   * when you deliberately want the judge to pick rather than union.
   *
   * Under `merge` the synthesis spawn uses the composer agent and contract
   * instead of the judge's. It reuses the judge run slot, so no new
   * `FusionPhase` is introduced and `fusion:rpc:v1` stays compatible.
   */
  synthesis?: FusionSynthesisMode;
}

/**
 * Facets are the thing that actually decides how answers combine, so the mode
 * follows them by default. Requiring `synthesis` and `question` to agree made
 * two ways to get a silently wrong report: facets judged for consensus they
 * cannot have, or a composer told to merge facets that do not exist.
 */
/**
 * Report label for a panel item. `label` is optional; it falls back to `id`, and
 * then to the position. One definition so report and prompt never disagree.
 */
export function panelItemLabel(
  item: Pick<PanelOutput, "index" | "id" | "label">,
): string {
  return item.label?.trim() || item.id?.trim() || `Panelist ${item.index + 1}`;
}

/** Report label for a member; `label` is optional and falls back to `id`. */
export function memberLabel(
  member: Pick<PanelMemberConfig, "id" | "label">,
): string {
  return member.label?.trim() || member.id;
}

export function resolveSynthesisMode(
  profile: Pick<FusionProfile, "panel" | "synthesis">,
): FusionSynthesisMode {
  if (profile.synthesis) return profile.synthesis;
  return profile.panel.some((member) => member.question?.trim())
    ? "merge"
    : "select";
}

export interface ToolBudget {
  soft?: number;
  hard?: number;
  block?: "*" | string[];
}

export type PanelConfidence = "low" | "medium" | "high";

export interface PanelDecision {
  recommendation: string;
  confidence: PanelConfidence;
  needsMoreEvidence: boolean;
  answerMarkdown: string;
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ModelAttempt {
  model: string;
  success: boolean;
  error?: string;
}

export interface ProviderFailure {
  provider: string;
  model?: string;
  message: string;
  count?: number;
}

export interface RunObservation {
  model?: string;
  durationMs?: number;
  usage?: RunUsage;
  attempts?: ModelAttempt[];
  providerFailures?: ProviderFailure[];
}

export interface FusionConfig {
  defaultProfile: string;
  profiles: Record<string, FusionProfile>;
}

export interface ParsedFusionArgs {
  prompt: string;
  profile?: string;
  operationId?: string;
  outputContract?: CallerOutputContract;
  /** Inline panel entries from `--panel`: `<model>` or `<agent>:<model>`. */
  panel?: string[];
  timeoutOverrides?: FusionTimeoutOverrides;
}

export interface PanelOutput {
  index: number;
  agent: string;
  output: string;
  id?: string;
  label?: string;
  role?: string;
  model?: string;
  configuredModel?: string;
  decision?: PanelDecision;
  observation?: RunObservation;
  artifactPath?: string;
  sessionPath?: string;
}

export type PanelFailureReason =
  "provider" | "timeout" | "interrupted" | "stopped-after-agreement";

export interface FailedPanelSummary {
  index: number;
  agent: string;
  summary: string;
  id?: string;
  label?: string;
  role?: string;
  model?: string;
  configuredModel?: string;
  reason?: PanelFailureReason;
  observation?: RunObservation;
  artifactPath?: string;
  sessionPath?: string;
}

export type FusionPhase =
  "panel" | "chain" | "judge" | "done" | "failed" | "cancelled";

export type CompletionQuality = "complete" | "partial";

/**
 * The start-time settings required after a process restart. This intentionally
 * excludes panel execution-only values (concurrency, panel tool budget, and
 * raw timeout fields): the panel is already running, while resolved deadlines
 * are persisted separately in `effectiveTimeouts`.
 */
export interface FusionProfileSnapshot {
  panel: PanelMemberConfig[];
  judge: JudgeConfig;
  minimumSuccessfulPanelists: number;
  context?: FusionContextMode;
  stopWhenPanelAgrees?: boolean;
  blindPanelLabels?: boolean;
  judgeToolBudget?: ToolBudget;
  synthesis?: FusionSynthesisMode;
}

/** Persisted recovery metadata for a terminal run. Failed-only retry is not
 * yet exposed, so this records exactly which slots a future explicit retry may
 * safely target without replaying verified completed work. */
export interface FusionRecoveryState {
  retryDeferred: true;
  failedPanelIndices: number[];
}

/**
 * Durable record written before a public RPC spawn. The public API cannot
 * query by this correlation token, so a restored intent without its returned
 * run ID is deliberately failed instead of risking a duplicate remote run.
 */
export interface FusionSpawnIntent {
  stage: "panel" | "judge";
  requestedAt: number;
}

export interface FusionRun {
  id: string;
  prompt: string;
  profileName: string;
  /**
   * Inline `--panel` entries, when the run used them. `profileName` then carries
   * a display name that no config defines, so restore rebuilds the profile from
   * `baseProfileName` plus these entries instead of looking the display name up.
   */
  inlinePanel?: string[];
  /** Name of the config profile the inline panel was layered onto. */
  baseProfileName?: string;
  operationId?: string;
  outputContract?: CallerOutputContract;
  /** Persisted start policy so recovery is not changed by later config edits. */
  minimumSuccessfulPanelists?: MinimumSuccessfulPanelists;
  /**
   * Additive start-time profile snapshot. Old sessions omit it and retain the
   * legacy config lookup fallback during restore.
   */
  profileSnapshot?: FusionProfileSnapshot;
  timeoutOverrides?: FusionTimeoutOverrides;
  effectiveTimeouts?: EffectiveFusionTimeouts;
  completionQuality?: CompletionQuality;
  phase: FusionPhase;
  createdAt: number;
  updatedAt: number;
  chainRunId?: string;
  chainAsyncDir?: string;
  panelRunId?: string;
  panelAsyncDir?: string;
  panelStopReason?: "agreement";
  panelStoppedIndices?: number[];
  judgeRunId?: string;
  judgeAsyncDir?: string;
  judgeObservation?: RunObservation;
  panelOutputs?: PanelOutput[];
  panelFailures?: FailedPanelSummary[];
  recovery?: FusionRecoveryState;
  spawnIntent?: FusionSpawnIntent;
  report?: string;
  error?: string;
}
