import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyClaudeAliasShorthand } from "./claude-aliases.js";
import { FusionConfigError } from "./errors.js";
import {
  JUDGE_AGENT,
  PANEL_AGENT,
  THINKING_LEVELS,
  type FusionConfig,
  type FusionContextMode,
  type FusionProfile,
  type JudgeConfig,
  type PanelMemberConfig,
  type ThinkingLevel,
  type ToolBudget,
} from "./types.js";
import {
  isNodeErrorCode,
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
} from "./utils.js";

export const FUSION_CONFIG_FILE = "fusion.json";
export const DEFAULT_PROFILE_NAME = "quality";
export {
  COMPOSER_AGENT,
  JUDGE_AGENT,
  PANEL_AGENT,
  PANEL_AGENT_FULL,
  PANEL_AGENT_WEB,
} from "./types.js";

/**
 * Tool names Fusion's bundled agents may declare: Pi core child tools plus the
 * tools contributed by `pi-web-providers`. A name outside this set resolves to
 * nothing at runtime, so a typo is only discovered after a panel run is spent.
 * Single source of truth for `test/unit/agents.test.ts`.
 */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_contents",
  "web_answer",
  "web_research",
];

/**
 * Agent references are dot-separated (`<package>.<name>`, or a bare local name).
 * This deliberately does not enforce the lowercase `IDENTIFIER_PATTERN` that
 * pi-subagents applies to package names: that pattern does not cover the
 * frontmatter `name`, and rejecting a config that would actually run is worse
 * than accepting a malformed one. It catches the real typo classes only —
 * embedded whitespace, empty segments, leading or trailing dots.
 */
const AGENT_REFERENCE_PATTERN = /^[^\s.]+(?:\.[^\s.]+)*$/;

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
        panelTimeoutMs: 900_000,
        judgeTimeoutMs: 900_000,
        panelToolBudget: { soft: 8, hard: 12, block: "*" },
        judgeToolBudget: { soft: 8, hard: 12, block: "*" },
        context: "fresh",
        stopWhenPanelAgrees: false,
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
    if (projectConfig) {
      return applyClaudeAliasShorthand(projectConfig, ctx, deps);
    }
  }

  const globalPath = getGlobalFusionConfigPath(deps.agentDir);
  const globalConfig = await readOptionalConfig(globalPath, readTextFile);
  const config = globalConfig ?? createDefaultFusionConfig();
  return applyClaudeAliasShorthand(config, ctx, deps);
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

/**
 * Splits an inline `--panel` entry into agent and model.
 *
 * Two shapes collide on `:` — an agent-qualified entry
 * (`pi-fusion.fusion-panelist-web:gpt-5.5`) and a model with a thinking suffix
 * (`gpt-4.1:high`). A dot in the prefix is not enough to tell them apart:
 * dotted model versions like `gpt-4.1`, `claude-3.5-haiku`, and
 * `gemini-2.5-pro` are common. The suffix decides — if it is a thinking level,
 * the whole entry is a model.
 */
export function splitInlinePanelEntry(entry: string): {
  agent: string;
  model: string;
} {
  const trimmed = entry.trim();
  const separator = trimmed.indexOf(":");
  if (separator > 0) {
    const prefix = trimmed.slice(0, separator);
    const rest = trimmed.slice(separator + 1).trim();
    if (
      prefix.includes(".") &&
      !prefix.includes("/") &&
      rest &&
      !isThinkingLevel(rest)
    ) {
      return { agent: prefix, model: rest };
    }
  }
  return { agent: PANEL_AGENT, model: trimmed };
}

/**
 * Builds an ephemeral profile from `--panel`. The resolved profile still
 * supplies the judge and every other setting; only the panel is replaced.
 */
export function buildInlinePanelProfile(
  base: FusionProfile,
  entries: readonly string[],
): FusionProfile {
  const usedIds = new Set<string>();
  const panel = entries.map((entry, index) => {
    const { agent, model } = splitInlinePanelEntry(entry);
    if (!model) {
      throw new FusionConfigError(
        `Inline panel entry "${entry}" has no model.`,
      );
    }
    if (!isAgentReference(agent)) {
      throw new FusionConfigError(
        `Inline panel entry "${entry}" has a malformed agent reference.`,
      );
    }
    return {
      id: uniqueInlineId(model, index, usedIds),
      label: model,
      agent,
      model,
    };
  });
  // Inline members have no `question`, so they all answer the whole task.
  // Carrying `synthesis: "merge"` over from the base profile would tell the
  // composer to merge facets that do not exist.
  const { synthesis: _dropped, ...rest } = base;
  return { ...rest, panel };
}

function uniqueInlineId(
  model: string,
  index: number,
  used: Set<string>,
): string {
  const base =
    model
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || `panel_${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;
  used.add(candidate);
  return candidate;
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
  if (
    value.panelistTimeoutMs !== undefined &&
    !isPositiveInteger(value.panelistTimeoutMs)
  ) {
    return false;
  }
  if (
    value.panelTimeoutMs !== undefined &&
    !isPositiveInteger(value.panelTimeoutMs)
  ) {
    return false;
  }
  if (
    value.panelGraceMs !== undefined &&
    !isPositiveInteger(value.panelGraceMs)
  ) {
    return false;
  }
  const panelTimeoutMs = value.panelTimeoutMs ?? value.timeoutMs ?? 900_000;
  const panelGraceMs = value.panelGraceMs ?? 5_000;
  // Never accept a configuration that would leave child panelists a 1ms
  // timeout after deadline capping. Overrides receive the same validation when
  // their effective values are resolved at run start.
  if (panelGraceMs >= panelTimeoutMs) return false;
  if (
    value.judgeTimeoutMs !== undefined &&
    !isPositiveInteger(value.judgeTimeoutMs)
  ) {
    return false;
  }
  if (
    value.minimumSuccessfulPanelists !== undefined &&
    value.minimumSuccessfulPanelists !== "majority" &&
    value.minimumSuccessfulPanelists !== "all" &&
    !isPositiveInteger(value.minimumSuccessfulPanelists)
  ) {
    return false;
  }
  if (value.context !== undefined && !isFusionContextMode(value.context))
    return false;
  if (
    value.stopWhenPanelAgrees !== undefined &&
    typeof value.stopWhenPanelAgrees !== "boolean"
  ) {
    return false;
  }
  if (
    value.blindPanelLabels !== undefined &&
    typeof value.blindPanelLabels !== "boolean"
  ) {
    return false;
  }
  if (
    value.panelToolBudget !== undefined &&
    !isToolBudget(value.panelToolBudget)
  ) {
    return false;
  }
  if (
    value.judgeToolBudget !== undefined &&
    !isToolBudget(value.judgeToolBudget)
  ) {
    return false;
  }
  if (
    value.synthesis !== undefined &&
    value.synthesis !== "select" &&
    value.synthesis !== "merge"
  ) {
    return false;
  }
  return true;
}

function isToolBudget(value: unknown): value is ToolBudget {
  if (!isRecord(value)) return false;
  if (value.soft === undefined && value.hard === undefined) return false;
  if (value.soft !== undefined && !isPositiveInteger(value.soft)) return false;
  if (value.hard !== undefined && !isPositiveInteger(value.hard)) return false;
  if (
    isPositiveInteger(value.soft) &&
    isPositiveInteger(value.hard) &&
    value.soft > value.hard
  ) {
    return false;
  }
  if (
    value.block !== undefined &&
    value.block !== "*" &&
    (!Array.isArray(value.block) ||
      value.block.length === 0 ||
      !value.block.every(isNonEmptyString))
  ) {
    return false;
  }
  return true;
}

export function isAgentReference(value: unknown): value is string {
  return isNonEmptyString(value) && AGENT_REFERENCE_PATTERN.test(value.trim());
}

function isPanelMemberConfig(value: unknown): value is PanelMemberConfig {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (value.label !== undefined && !isNonEmptyString(value.label)) return false;
  if (!isAgentReference(value.agent)) return false;
  if (value.model !== undefined && !isNonEmptyString(value.model)) return false;
  if (value.thinking !== undefined && !isThinkingLevel(value.thinking))
    return false;
  if (value.role !== undefined && typeof value.role !== "string") return false;
  if (value.question !== undefined && !isNonEmptyString(value.question)) {
    return false;
  }
  return true;
}

function isJudgeConfig(value: unknown): value is JudgeConfig {
  if (!isRecord(value)) return false;
  if (!isAgentReference(value.agent)) return false;
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

async function readUtf8File(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function writeUtf8File(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

async function mkdirRecursive(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
