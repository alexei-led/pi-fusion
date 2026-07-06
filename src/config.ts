import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FusionConfigError } from "./errors.js";
import {
  THINKING_LEVELS,
  type FusionConfig,
  type FusionContextMode,
  type FusionProfile,
  type JudgeConfig,
  type PanelMemberConfig,
  type ThinkingLevel,
} from "./types.js";

export const FUSION_CONFIG_FILE = "fusion.json";
export const DEFAULT_PROFILE_NAME = "quality";
export const PANEL_AGENT = "pi-fusion.fusion-panelist";
export const JUDGE_AGENT = "pi-fusion.fusion-judge";

export interface FusionConfigLoadContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

interface FileReadDeps {
  readTextFile?: (path: string) => Promise<string>;
  agentDir?: string;
}

interface FileWriteDeps {
  writeTextFile?: (path: string, content: string) => Promise<void>;
  ensureDir?: (path: string) => Promise<void>;
}

export interface ResolvedFusionProfile {
  name: string;
  profile: FusionProfile;
}

export function createDefaultFusionConfig(): FusionConfig {
  return {
    defaultProfile: DEFAULT_PROFILE_NAME,
    profiles: {
      [DEFAULT_PROFILE_NAME]: {
        panel: [
          {
            id: "architect",
            label: "Architect",
            agent: PANEL_AGENT,
            thinking: "high",
            role: "architecture, tradeoffs, and failure modes",
          },
          {
            id: "implementer",
            label: "Implementer",
            agent: PANEL_AGENT,
            thinking: "medium",
            role: "implementation details, API contracts, and edge cases",
          },
          {
            id: "tester",
            label: "Tester",
            agent: PANEL_AGENT,
            thinking: "medium",
            role: "test strategy, regressions, and verification",
          },
        ],
        judge: {
          agent: JUDGE_AGENT,
          thinking: "high",
        },
        concurrency: 3,
        timeoutMs: 300_000,
        context: "fresh",
      },
    },
  };
}

export function getProjectFusionConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, FUSION_CONFIG_FILE);
}

export function getGlobalFusionConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, FUSION_CONFIG_FILE);
}

export function getFusionConfigTemplate(): string {
  return `${JSON.stringify(createDefaultFusionConfig(), null, 2)}\n`;
}

export async function loadFusionConfig(
  ctx: FusionConfigLoadContext,
  deps: FileReadDeps = {},
): Promise<FusionConfig> {
  const readTextFile = deps.readTextFile ?? readUtf8File;

  if (ctx.isProjectTrusted()) {
    const projectPath = getProjectFusionConfigPath(ctx.cwd);
    const projectConfig = await readOptionalConfig(projectPath, readTextFile);
    if (projectConfig) return projectConfig;
  }

  const globalPath = getGlobalFusionConfigPath(deps.agentDir);
  const globalConfig = await readOptionalConfig(globalPath, readTextFile);
  return globalConfig ?? createDefaultFusionConfig();
}

export function resolveProfile(
  config: FusionConfig,
  requested?: string,
): ResolvedFusionProfile {
  const name = requested?.trim() || config.defaultProfile;
  const profile = config.profiles[name];
  if (!profile) {
    const knownProfiles =
      Object.keys(config.profiles).sort().join(", ") || "none";
    throw new FusionConfigError(
      `Unknown fusion profile "${name}". Known profiles: ${knownProfiles}.`,
    );
  }
  if (profile.panel.length === 0) {
    throw new FusionConfigError(
      `Fusion profile "${name}" must define at least one panel member.`,
    );
  }
  return { name, profile };
}

export async function writeProjectFusionConfigTemplate(
  cwd: string,
  deps: FileWriteDeps = {},
): Promise<string> {
  const configPath = getProjectFusionConfigPath(cwd);
  const ensureDir = deps.ensureDir ?? mkdirRecursive;
  const writeTextFile = deps.writeTextFile ?? writeUtf8File;
  await ensureDir(dirname(configPath));
  await writeTextFile(configPath, getFusionConfigTemplate());
  return configPath;
}

async function readOptionalConfig(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<FusionConfig | undefined> {
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new FusionConfigError(
      `Could not read fusion config at ${path}: ${message}`,
    );
  }
  return parseFusionConfig(raw, path);
}

export function parseFusionConfig(raw: string, source: string): FusionConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FusionConfigError(
      `Invalid JSON in fusion config at ${source}: ${message}`,
    );
  }
  if (!isFusionConfig(value)) {
    throw new FusionConfigError(
      `Invalid fusion config at ${source}. Expected defaultProfile and profiles.`,
    );
  }
  return value;
}

export function isFusionConfig(value: unknown): value is FusionConfig {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.defaultProfile)) return false;
  if (!isRecord(value.profiles)) return false;
  return Object.values(value.profiles).every(isFusionProfile);
}

function isFusionProfile(value: unknown): value is FusionProfile {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.panel) || !value.panel.every(isPanelMemberConfig))
    return false;
  if (!isJudgeConfig(value.judge)) return false;
  if (value.concurrency !== undefined && !isPositiveInteger(value.concurrency))
    return false;
  if (value.timeoutMs !== undefined && !isPositiveInteger(value.timeoutMs))
    return false;
  if (value.context !== undefined && !isFusionContextMode(value.context))
    return false;
  return true;
}

function isPanelMemberConfig(value: unknown): value is PanelMemberConfig {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.label)) return false;
  if (!isNonEmptyString(value.agent)) return false;
  if (value.model !== undefined && !isNonEmptyString(value.model)) return false;
  if (value.thinking !== undefined && !isThinkingLevel(value.thinking))
    return false;
  if (value.role !== undefined && typeof value.role !== "string") return false;
  return true;
}

function isJudgeConfig(value: unknown): value is JudgeConfig {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.agent)) return false;
  if (value.model !== undefined && !isNonEmptyString(value.model)) return false;
  if (value.thinking !== undefined && !isThinkingLevel(value.thinking))
    return false;
  return true;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

function isFusionContextMode(value: unknown): value is FusionContextMode {
  return value === "fresh" || value === "fork";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function readUtf8File(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function writeUtf8File(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

async function mkdirRecursive(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
