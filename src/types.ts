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
}

export interface FusionConfig {
  defaultProfile: string;
  profiles: Record<string, FusionProfile>;
}

export interface ParsedFusionArgs {
  prompt: string;
  profile?: string;
}

export interface PanelOutput {
  index: number;
  agent: string;
  output: string;
  id?: string;
  label?: string;
  role?: string;
  model?: string;
  artifactPath?: string;
  sessionPath?: string;
}

export interface FailedPanelSummary {
  index: number;
  agent: string;
  summary: string;
  id?: string;
  label?: string;
  role?: string;
  model?: string;
  artifactPath?: string;
  sessionPath?: string;
}

export type FusionPhase =
  "panel" | "chain" | "judge" | "done" | "failed" | "cancelled";

export interface FusionRun {
  id: string;
  prompt: string;
  profileName: string;
  phase: FusionPhase;
  createdAt: number;
  updatedAt: number;
  chainRunId?: string;
  chainAsyncDir?: string;
  panelRunId?: string;
  judgeRunId?: string;
  judgeAsyncDir?: string;
  panelOutputs?: PanelOutput[];
  panelFailures?: FailedPanelSummary[];
  report?: string;
  error?: string;
}
