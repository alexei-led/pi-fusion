import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import {
  getProjectFusionConfigPath,
  writeProjectFusionConfigTemplate,
} from "./config.js";
import { FusionConfigError } from "./errors.js";
import { parseFusionInlineCommand } from "./fusion-args.js";
import type { ParsedFusionArgs } from "./types.js";
import { isNodeErrorCode } from "./utils.js";

const FUSION_HELP = [
  "Fusion commands",
  "/fusion <prompt>",
  "/fusion --profile <name> <prompt>",
  "/fusion status",
  "/fusion stop",
  "/fusion init",
].join("\n");

export interface FusionRuntimeCommandHandler {
  startRun(
    args: string | ParsedFusionArgs,
    ctx: ExtensionCommandContext,
  ): Promise<unknown>;
  showStatus(ctx: ExtensionCommandContext): Promise<unknown>;
  cancelActiveRun(ctx: ExtensionCommandContext): Promise<unknown>;
}

export function registerFusionCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  handler: FusionRuntimeCommandHandler,
): void {
  pi.registerCommand("fusion", {
    description: "Run a fusion review, or use status/stop/init",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim() === "") {
        ctx.ui.notify(FUSION_HELP, "info");
        return;
      }

      const inlineCommand = parseFusionInlineCommand(args);
      if (inlineCommand === "init") {
        await runFusionInit(ctx);
        return;
      }
      if (inlineCommand === "status") {
        await handler.showStatus(ctx);
        return;
      }
      if (inlineCommand === "stop") {
        await handler.cancelActiveRun(ctx);
        return;
      }
      await handler.startRun(args, ctx);
    },
  });
}

export async function runFusionInit(
  ctx: FusionInitContext,
  deps: FusionInitDeps = {},
): Promise<FusionInitResult> {
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(
      "Project is not trusted. /fusion init did not write .pi/fusion.json.",
      "error",
    );
    return { status: "skipped", reason: "untrusted" };
  }

  const configPath = getProjectFusionConfigPath(ctx.cwd);
  if (await fileExists(configPath, deps.readTextFile ?? readUtf8File)) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `${configPath} already exists. Run /fusion init in UI mode to confirm overwrite.`,
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

async function readUtf8File(path: string): Promise<string> {
  return readFile(path, "utf8");
}
