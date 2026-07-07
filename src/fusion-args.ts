import { FusionArgsError } from "./errors.js";
import type { ParsedFusionArgs } from "./types.js";

const FUSION_USAGE =
  "Usage: /fusion <prompt> | /fusion --profile <name> <prompt> | /fusion status | /fusion stop | /fusion init.";

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
