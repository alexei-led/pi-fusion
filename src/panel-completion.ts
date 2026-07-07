import { renderPanelFailureReport, renderSinglePanelReport } from "./report.js";
import {
  appendThinkingSuffix,
  buildJudgeSpawnParams,
  type JudgeSpawnParams,
} from "./run-builder.js";
import type {
  FailedPanelSummary,
  FusionProfile,
  FusionRun,
  PanelOutput,
} from "./types.js";

export type PanelCompletionDecision =
  | { kind: "fail"; error: string; report: string }
  | { kind: "complete"; report: string }
  | {
      kind: "judge";
      params: JudgeSpawnParams;
      missingRunIdError: string;
      notification: string;
    };

export interface DecidePanelCompletionInput {
  run: FusionRun;
  profile: FusionProfile;
  panelOutputs: readonly PanelOutput[];
  panelFailures: readonly FailedPanelSummary[];
  fallbackJudge?: boolean;
}

export function decidePanelCompletion(
  input: DecidePanelCompletionInput,
): PanelCompletionDecision {
  const judgeModel = configuredJudgeModel(input.profile);

  if (input.panelOutputs.length === 0) {
    const report = renderPanelFailureReport({
      run: input.run,
      failures: input.panelFailures,
      ...withJudgeModel(judgeModel),
    });
    return {
      kind: "fail",
      error: "No fusion panelists completed successfully.",
      report,
    };
  }

  if (input.panelOutputs.length === 1) {
    const report = renderSinglePanelReport({
      run: input.run,
      output: input.panelOutputs[0]!,
      failures: input.panelFailures,
      ...withJudgeModel(judgeModel),
    });
    return { kind: "complete", report };
  }

  return {
    kind: "judge",
    params: buildJudgeSpawnParams({
      profile: input.profile,
      prompt: input.run.prompt,
      panelOutputs: input.panelOutputs,
      failedPanelists: input.panelFailures,
    }),
    missingRunIdError: input.fallbackJudge
      ? "pi-subagents spawn did not return a fallback judge run ID."
      : "pi-subagents spawn did not return a judge run ID.",
    notification: input.fallbackJudge
      ? "Fusion fallback judge started"
      : "Fusion judge started",
  };
}

function configuredJudgeModel(profile: FusionProfile): string | undefined {
  return appendThinkingSuffix(profile.judge.model, profile.judge.thinking);
}

function withJudgeModel(
  judgeModel: string | undefined,
): { judgeModel: string } | Record<string, never> {
  return judgeModel ? { judgeModel } : {};
}
