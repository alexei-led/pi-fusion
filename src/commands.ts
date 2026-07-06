import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import {
  getProjectFusionConfigPath,
  writeProjectFusionConfigTemplate,
} from "./config.js";
import { FusionArgsError, FusionConfigError } from "./errors.js";

const FUSION_USAGE = "Usage: /fusion [--profile <name>] <prompt>.";

export interface ParsedFusionArgs {
  prompt: string;
  profile?: string;
}

interface FusionInitContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export interface FusionInitDeps {
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
  ensureDir?: (path: string) => Promise<void>;
}

export type FusionInitResult =
  | { status: "written"; path: string }
  | {
      status: "skipped";
      reason: "untrusted" | "exists" | "cancelled";
      path?: string;
    };

export function registerFusionInitCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
): void {
  pi.registerCommand("fusion-init", {
    description: "Create a project-local .pi/fusion.json template",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await runFusionInit(ctx);
    },
  });
}

export async function runFusionInit(
  ctx: FusionInitContext,
  deps: FusionInitDeps = {},
): Promise<FusionInitResult> {
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(
      "Project is not trusted. /fusion-init did not write .pi/fusion.json.",
      "error",
    );
    return { status: "skipped", reason: "untrusted" };
  }

  const configPath = getProjectFusionConfigPath(ctx.cwd);
  if (await fileExists(configPath, deps.readTextFile ?? readUtf8File)) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `${configPath} already exists. Run /fusion-init in UI mode to confirm overwrite.`,
        "warning",
      );
      return { status: "skipped", reason: "exists", path: configPath };
    }

    const overwrite = await ctx.ui.confirm(
      "Overwrite fusion config?",
      `${configPath} already exists. Overwrite it?`,
    );
    if (!overwrite) {
      ctx.ui.notify("Kept existing .pi/fusion.json.", "info");
      return { status: "skipped", reason: "cancelled", path: configPath };
    }
  }

  const writtenPath = await writeProjectFusionConfigTemplate(ctx.cwd, deps);
  ctx.ui.notify(`Wrote ${writtenPath}.`, "info");
  return { status: "written", path: writtenPath };
}

export function parseFusionArgs(
  input: string | readonly string[],
): ParsedFusionArgs {
  const tokens =
    typeof input === "string" ? tokenizeCommandArgs(input) : [...input];
  if (tokens[0] === "/fusion" || tokens[0] === "fusion") tokens.shift();

  let profile: string | undefined;
  const promptTokens: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;

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

    if (promptTokens.length === 0 && token.startsWith("-")) {
      throw new FusionArgsError(`Unknown option ${token}. ${FUSION_USAGE}`);
    }

    promptTokens.push(token, ...tokens.slice(index + 1));
    break;
  }

  const prompt = promptTokens.join(" ").trim();
  if (!prompt) throw new FusionArgsError(FUSION_USAGE);
  return profile ? { prompt, profile } : { prompt };
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

async function fileExists(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<boolean> {
  try {
    await readTextFile(path);
    return true;
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new FusionConfigError(
      `Could not check fusion config at ${path}: ${message}`,
    );
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function readUtf8File(path: string): Promise<string> {
  return readFile(path, "utf8");
}
