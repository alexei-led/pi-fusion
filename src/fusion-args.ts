import { FusionArgsError } from "./errors.js";
import type { FusionTimeoutOverrides, ParsedFusionArgs } from "./types.js";

const FUSION_USAGE =
  "Usage: /fusion <prompt> | /fusion --profile <name> <prompt> | /fusion --panel <models> <prompt> [--judge <agent>[:<model>[:<level>]]] [--panelist-timeout-ms n --panel-timeout-ms n --panel-grace-ms n --judge-timeout-ms n] | /fusion status | /fusion stop | /fusion init.";

export type FusionInlineCommand = "init" | "status" | "stop";

export function parseFusionInlineCommand(
  input: string | readonly string[],
): FusionInlineCommand | undefined {
  const tokens =
    typeof input === "string" ? tokenizeCommandArgs(input) : [...input];
  if (tokens.length !== 1) return undefined;
  const command = tokens[0];
  if (command === "init" || command === "status" || command === "stop") {
    return command;
  }
  return undefined;
}

export function parseFusionArgs(
  input: string | readonly string[],
): ParsedFusionArgs {
  const tokens =
    typeof input === "string" ? tokenizeCommandArgs(input) : [...input];
  if (tokens[0] === "/fusion" || tokens[0] === "fusion") tokens.shift();

  let profile: string | undefined;
  let panel: string[] | undefined;
  let judgeOverride: string | undefined;
  const timeoutOverrides: FusionTimeoutOverrides = {};
  const timeoutOptions: Record<string, keyof FusionTimeoutOverrides> = {
    "--panelist-timeout-ms": "panelistTimeoutMs",
    "--panel-timeout-ms": "panelTimeoutMs",
    "--panel-grace-ms": "panelGraceMs",
    "--judge-timeout-ms": "judgeTimeoutMs",
  };
  const promptTokens: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;

    if (promptTokens.length === 0 && token === "--panel") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) {
        throw new FusionArgsError(`Missing value for --panel. ${FUSION_USAGE}`);
      }
      if (panel) throw new FusionArgsError("Panel can only be provided once.");
      panel = parsePanelEntries(value);
      index++;
      continue;
    }

    if (promptTokens.length === 0 && token.startsWith("--panel=")) {
      const value = token.slice("--panel=".length);
      if (panel) throw new FusionArgsError("Panel can only be provided once.");
      panel = parsePanelEntries(value);
      continue;
    }

    if (
      promptTokens.length === 0 &&
      (token === "--profile" || token === "-p")
    ) {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) {
        throw new FusionArgsError(
          `Missing value for ${token}. ${FUSION_USAGE}`,
        );
      }
      if (profile)
        throw new FusionArgsError("Profile can only be provided once.");
      profile = value;
      index++;
      continue;
    }

    if (promptTokens.length === 0 && token.startsWith("--profile=")) {
      const value = token.slice("--profile=".length).trim();
      if (!value)
        throw new FusionArgsError(
          `Missing value for --profile. ${FUSION_USAGE}`,
        );
      if (profile)
        throw new FusionArgsError("Profile can only be provided once.");
      profile = value;
      continue;
    }

    if (promptTokens.length === 0 && token === "--judge") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) {
        throw new FusionArgsError(`Missing value for --judge. ${FUSION_USAGE}`);
      }
      if (judgeOverride) {
        throw new FusionArgsError("Judge can only be provided once.");
      }
      judgeOverride = value;
      parseJudgeSegments(judgeOverride);
      index++;
      continue;
    }

    if (promptTokens.length === 0 && token.startsWith("--judge=")) {
      const value = token.slice("--judge=".length).trim();
      if (!value) {
        throw new FusionArgsError(`Missing value for --judge. ${FUSION_USAGE}`);
      }
      if (judgeOverride) {
        throw new FusionArgsError("Judge can only be provided once.");
      }
      judgeOverride = value;
      parseJudgeSegments(judgeOverride);
      continue;
    }

    const timeoutKey = timeoutOptions[token];
    const timeoutEquals = Object.entries(timeoutOptions).find(([option]) =>
      token.startsWith(`${option}=`),
    );
    if (promptTokens.length === 0 && (timeoutKey || timeoutEquals)) {
      const key = timeoutKey ?? timeoutEquals?.[1];
      const raw = timeoutKey ? tokens[index + 1] : token.slice((timeoutEquals?.[0].length ?? 0) + 1);
      const value = raw ? Number(raw) : NaN;
      if (!key || !Number.isInteger(value) || value <= 0) {
        throw new FusionArgsError(`Timeout options require a positive integer milliseconds value. ${FUSION_USAGE}`);
      }
      if (timeoutOverrides[key] !== undefined) {
        throw new FusionArgsError(`${token.split("=")[0]} can only be provided once.`);
      }
      timeoutOverrides[key] = value;
      if (timeoutKey) index++;
      continue;
    }

    if (promptTokens.length === 0 && token.startsWith("-")) {
      throw new FusionArgsError(`Unknown option ${token}. ${FUSION_USAGE}`);
    }

    promptTokens.push(token, ...tokens.slice(index + 1));
    break;
  }

  const prompt = promptTokens.join(" ").trim();
  if (!prompt) throw new FusionArgsError(FUSION_USAGE);
  return {
    prompt,
    ...(profile ? { profile } : {}),
    ...(panel ? { panel } : {}),
    ...(judgeOverride ? { judgeOverride } : {}),
    ...(Object.keys(timeoutOverrides).length ? { timeoutOverrides } : {}),
  };
}

function parsePanelEntries(value: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new FusionArgsError(`Missing value for --panel. ${FUSION_USAGE}`);
  }
  return entries;
}

/**
 * Splits a `--judge` spec into its 1–3 colon-separated segments. Segment
 * shape is validated here; whether the tail segment is a thinking level or
 * part of the model id is decided later by `composeJudgeOverride`, which
 * needs the configured thinking-level registry.
 */
export function parseJudgeSegments(spec: string): string[] {
  const segments = spec.split(":").map((segment) => segment.trim());
  if (segments.length > 3) {
    throw new FusionArgsError(
      `--judge accepts at most 3 segments: <agent>[:<model>[:<level>]]. ${FUSION_USAGE}`,
    );
  }
  if (segments.some((segment) => segment === "")) {
    throw new FusionArgsError(
      `--judge segments must be non-empty: <agent>[:<model>[:<level>]]. ${FUSION_USAGE}`,
    );
  }
  return segments;
}

export function tokenizeCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (quote)
    throw new FusionArgsError(`Unclosed ${quote} quote in /fusion arguments.`);
  if (current) tokens.push(current);
  return tokens;
}
