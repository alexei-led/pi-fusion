import type { CallerOutputContract } from "./types.js";

export type CallerOutputValidation =
  | { ok: true }
  | { ok: false; error: string };

const PLAN_REVIEW_HEADER = /^FINDING:\s*(CRITICAL|MAJOR|MINOR)\s*\|\s*\S.*$/;

export function isCallerOutputContract(
  value: unknown,
): value is CallerOutputContract {
  return value === "plan-review-v1";
}

export function detectCallerOutputContract(
  prompt: string,
): CallerOutputContract | undefined {
  const hasExactCleanToken = /exact line\s+`?NO_FINDINGS`?/i.test(prompt);
  const hasFindingContract =
    /exact format[\s\S]*FINDING:\s*(?:CRITICAL\|MAJOR\|MINOR|CRITICAL|MAJOR|MINOR)/i.test(
      prompt,
    );
  const forbidsProse = /do not write any other prose/i.test(prompt);
  return hasExactCleanToken && hasFindingContract && forbidsProse
    ? "plan-review-v1"
    : undefined;
}

export function validateCallerOutput(
  contract: CallerOutputContract,
  output: string,
): CallerOutputValidation {
  switch (contract) {
    case "plan-review-v1":
      return validatePlanReviewOutput(output);
  }
}

export function callerOutputContractInstructions(
  contract: CallerOutputContract,
): readonly string[] {
  switch (contract) {
    case "plan-review-v1":
      return [
        "The exact output contract in the original task takes priority over Fusion's normal Markdown sections.",
        "Return only NO_FINDINGS or complete FINDING/Evidence/Fix blocks as requested by the original task.",
        "Do not add Fusion headings, commentary, or a panel decision record.",
      ];
  }
}

function validatePlanReviewOutput(output: string): CallerOutputValidation {
  const trimmed = output.trim();
  if (trimmed === "NO_FINDINGS") return { ok: true };

  const blocks = trimmed.split(/(?=^[ \t]*FINDING:\s)/m);
  if (
    blocks.length > 0 &&
    blocks.every((block) => {
      const lines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return (
        lines.length === 3 &&
        PLAN_REVIEW_HEADER.test(lines[0] ?? "") &&
        /^Evidence:\s*\S.*$/.test(lines[1] ?? "") &&
        /^Fix:\s*\S.*$/.test(lines[2] ?? "")
      );
    })
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      "Fusion synthesis violated the exact caller output contract. Expected NO_FINDINGS or complete FINDING/Evidence/Fix blocks with no other prose.",
  };
}
