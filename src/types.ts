export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type FusionContextMode = "fresh" | "fork";

export interface PanelMemberConfig {
  id: string;
  label: string;
  agent: string;
  model?: string;
  thinking?: ThinkingLevel;
  role?: string;
}

export interface JudgeConfig {
  agent: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface FusionProfile {
  panel: PanelMemberConfig[];
  judge: JudgeConfig;
  concurrency?: number;
  timeoutMs?: number;
  context?: FusionContextMode;
  stopWhenPanelAgrees?: boolean;
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

export interface FusionRun {
  id: string;
  prompt: string;
  profileName: string;
  operationId?: string;
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
  report?: string;
  error?: string;
}
