import { FusionArgsError } from "./errors.js";

/**
 * Usage line embedded in every `FusionArgsError` message. Lives beside the
 * judge-spec grammar it documents (`<agent>[:<model>[:<level>]]`) so the CLI
 * layer and the composition layer quote one identical string.
 */
export const FUSION_USAGE =
  "Usage: /fusion <prompt> | /fusion --profile <name> <prompt> | /fusion --panel <models> <prompt> [--judge <agent>[:<model>[:<level>]]] [--panelist-timeout-ms n --panel-timeout-ms n --panel-grace-ms n --judge-timeout-ms n] | /fusion status | /fusion stop | /fusion init.";

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
