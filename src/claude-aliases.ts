import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FusionConfig } from "./types.js";
import { FusionConfigError } from "./errors.js";
import { isNodeErrorCode, isNonEmptyString, isRecord } from "./utils.js";
import type { FusionConfigLoadContext } from "./config.js";

const CLAUDE_ALIAS_CONFIG_FILE = "claude-alias.json";

interface ClaudeAliasDefinition {
  slug: string;
  providerId: string;
  handle: string;
}

interface AliasFileDeps {
  readTextFile?: (path: string) => Promise<string>;
  agentDir?: string;
}

interface RawAliasConfig {
  aliases?: unknown;
}

interface RawAliasEntry {
  slug?: unknown;
  handle?: unknown;
}

export async function applyClaudeAliasShorthand(
  config: FusionConfig,
  ctx: FusionConfigLoadContext,
  deps: AliasFileDeps = {},
): Promise<FusionConfig> {
  const aliases = await loadClaudeAliases(ctx, deps);
  if (aliases.length === 0) return config;

  return {
    ...config,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => [
        name,
        {
          ...profile,
          panel: profile.panel.map((member) => ({
            ...member,
            ...(member.model
              ? { model: resolveClaudeAliasModelSpec(member.model, aliases) }
              : {}),
          })),
          judge: {
            ...profile.judge,
            ...(profile.judge.model
              ? { model: resolveClaudeAliasModelSpec(profile.judge.model, aliases) }
              : {}),
          },
        },
      ]),
    ),
  };
}

export function resolveClaudeAliasModelSpec(
  model: string,
  aliases: readonly ClaudeAliasDefinition[],
): string {
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return trimmed;

  const handle = trimmed.slice(0, slashIndex).trim().toLowerCase();
  const modelRef = trimmed.slice(slashIndex + 1).trim();
  const alias = aliases.find((item) => item.handle === handle);
  if (!alias) return trimmed;

  return `${alias.providerId}/${normalizeAnthropicModelRef(modelRef)}`;
}

export function normalizeAnthropicModelRef(modelRef: string): string {
  const normalized = modelRef
    .trim()
    .toLowerCase()
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) return modelRef.trim();
  return normalized.startsWith("claude-") ? normalized : `claude-${normalized}`;
}

async function loadClaudeAliases(
  ctx: FusionConfigLoadContext,
  deps: AliasFileDeps,
): Promise<ClaudeAliasDefinition[]> {
  const readTextFile = deps.readTextFile ?? readUtf8File;
  const global = await readOptionalAliasFile(
    getGlobalClaudeAliasConfigPath(deps.agentDir),
    readTextFile,
  );
  const project = ctx.isProjectTrusted()
    ? await readOptionalAliasFile(
        getProjectClaudeAliasConfigPath(ctx.cwd),
        readTextFile,
      )
    : undefined;

  const merged = new Map<string, ClaudeAliasDefinition>();
  for (const alias of global ?? []) {
    merged.set(alias.slug, alias);
  }
  for (const alias of project ?? []) {
    merged.set(alias.slug, alias);
  }

  const aliases = [...merged.values()];
  validateUniqueHandles(aliases);
  return aliases;
}

async function readOptionalAliasFile(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<ClaudeAliasDefinition[] | undefined> {
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new FusionConfigError(
      `Could not read Claude alias config at ${path}: ${message}`,
    );
  }

  return parseAliasFile(raw, path);
}

function parseAliasFile(raw: string, source: string): ClaudeAliasDefinition[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FusionConfigError(
      `Invalid JSON in Claude alias config at ${source}: ${message}`,
    );
  }

  if (!isRecord(value) || !Array.isArray((value as RawAliasConfig).aliases)) {
    throw new FusionConfigError(
      `Invalid Claude alias config at ${source}. Expected aliases array.`,
    );
  }

  const aliasValues = (value as { aliases: unknown[] }).aliases;
  const aliases: ClaudeAliasDefinition[] = [];
  for (const [index, entry] of aliasValues.entries()) {
    const parsed = parseAliasEntry(entry);
    if (!parsed) {
      throw new FusionConfigError(
        `Invalid Claude alias entry at ${source} aliases[${index}].`,
      );
    }
    aliases.push(parsed);
  }

  return dedupeAliases(aliases, source);
}

function parseAliasEntry(value: unknown): ClaudeAliasDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value as RawAliasEntry;

  const slug = normalizeSlug(entry.slug);
  if (!slug) return undefined;

  const handle = normalizeHandle(entry.handle) ?? `claude-${slug}`;
  if (!handle) return undefined;

  return {
    slug,
    providerId: `anthropic-${slug}`,
    handle,
  };
}

function dedupeAliases(
  aliases: readonly ClaudeAliasDefinition[],
  source: string,
): ClaudeAliasDefinition[] {
  const byHandle = new Set<string>();
  const deduped: ClaudeAliasDefinition[] = [];

  for (const alias of aliases) {
    if (byHandle.has(alias.handle)) {
      throw new FusionConfigError(
        `Duplicate Claude alias handle "${alias.handle}" in ${source}.`,
      );
    }
    byHandle.add(alias.handle);
    deduped.push(alias);
  }

  return deduped;
}

function validateUniqueHandles(
  aliases: readonly ClaudeAliasDefinition[],
): void {
  const seen = new Map<string, string>();

  for (const alias of aliases) {
    const existingSlug = seen.get(alias.handle);
    if (existingSlug && existingSlug !== alias.slug) {
      throw new FusionConfigError(
        `Duplicate Claude alias handle "${alias.handle}" across merged config. Use a unique handle for each alias.`,
      );
    }
    seen.set(alias.handle, alias.slug);
  }
}

function normalizeSlug(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) return undefined;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || undefined;
}

function normalizeHandle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) return undefined;
  const handle = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return handle || undefined;
}

function getGlobalClaudeAliasConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, CLAUDE_ALIAS_CONFIG_FILE);
}

function getProjectClaudeAliasConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CLAUDE_ALIAS_CONFIG_FILE);
}

async function readUtf8File(path: string): Promise<string> {
  return readFile(path, "utf8");
}
