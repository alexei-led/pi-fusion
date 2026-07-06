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

export type FusionPhase = "panel" | "judge" | "done" | "failed" | "cancelled";

export interface FusionRun {
  id: string;
  prompt: string;
  profileName: string;
  phase: FusionPhase;
  createdAt: number;
  updatedAt: number;
  panelRunId?: string;
  judgeRunId?: string;
  report?: string;
  error?: string;
}
