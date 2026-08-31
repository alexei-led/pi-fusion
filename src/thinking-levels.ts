import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

/**
 * Built-in thinking levels. Mirrors pi core's set. On top of these,
 * provider/model-specific levels can be registered from
 * `FusionConfig.extraThinkingLevels` (see `setExtraThinkingLevels`).
 */
export const BUILTIN_THINKING_LEVELS = THINKING_LEVELS;

let extraThinkingLevels: readonly string[] = [];

/**
 * Registers provider/model-specific thinking levels so they validate wherever
 * built-in levels do — inline `model:<level>` suffixes, profile `thinking`
 * fields, and snapshot validation. Config parsing validates the array first
 * and surfaces problems as `FusionConfigError`s; this is the defensive layer
 * for direct callers. Built-in names and duplicates are ignored, so a config
 * that lists them stays loadable.
 */
export function setExtraThinkingLevels(levels: readonly string[]): void {
  const seen = new Set<string>(BUILTIN_THINKING_LEVELS);
  const extras: string[] = [];
  for (const level of levels) {
    if (typeof level !== "string" || level.trim() === "") {
      throw new TypeError(
        "Extra thinking levels must be non-empty strings.",
      );
    }
    if (seen.has(level)) continue;
    seen.add(level);
    extras.push(level);
  }
  extraThinkingLevels = extras;
}

/** Clears registered extras. Used between config loads and in tests. */
export function resetExtraThinkingLevels(): void {
  extraThinkingLevels = [];
}

/** Levels registered by the active config, excluding built-ins. */
export function getExtraThinkingLevels(): readonly string[] {
  return extraThinkingLevels;
}

/**
 * True for built-in levels and for extras registered by the active config.
 * Extras are strings validated at config parse time, so the `ThinkingLevel`
 * claim intentionally extends past the built-in union at runtime.
 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  if (typeof value !== "string") return false;
  if ((BUILTIN_THINKING_LEVELS as readonly string[]).includes(value)) {
    return true;
  }
  return extraThinkingLevels.includes(value);
}

/** True when `model` already ends with a recognized `:<level>` suffix. */
export function hasThinkingSuffix(model: string): boolean {
  const colonIndex = model.lastIndexOf(":");
  if (colonIndex === -1) return false;
  return isThinkingLevel(model.slice(colonIndex + 1));
}
