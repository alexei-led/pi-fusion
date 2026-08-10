import { validateCallerOutput } from "./caller-contract.js";
import {
  renderFailureReport,
  renderPanelFailureReport,
  renderSinglePanelReport,
} from "./report.js";
import {
  appendThinkingSuffix,
  buildJudgeSpawnParams,
  type JudgeSpawnParams,
} from "./run-builder.js";
import {
  resolveSynthesisMode,
  type FailedPanelSummary,
  type FusionProfile,
  type FusionRun,
  type PanelOutput,
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
      synthesis: resolveSynthesisMode(input.profile),
      panel: input.profile.panel,
    });
    return {
      kind: "fail",
      error: "No fusion panelists completed successfully.",
      report,
    };
  }

  const intentionalStops =
    input.profile.stopWhenPanelAgrees === true &&
    input.panelOutputs.length >= 2 &&
    input.panelFailures.length > 0 &&
    input.panelFailures.every(
      ({ reason }) => reason === "stopped-after-agreement",
    );
  if (
    input.panelOutputs.length < input.profile.panel.length &&
    !intentionalStops
  ) {
    const error = `Only ${input.panelOutputs.length} of ${input.profile.panel.length} fusion panelists completed successfully; ${input.panelFailures.length} panelist result(s) are also missing.`;
    const report = renderFailureReport({
      run: input.run,
      error,
      panelOutputs: input.panelOutputs,
      failures: input.panelFailures,
      ...withJudgeModel(judgeModel),
      synthesis: resolveSynthesisMode(input.profile),
      panel: input.profile.panel,
    });
    return { kind: "fail", error, report };
  }

  if (input.panelOutputs.length === 1) {
    const callerContract = input.run.outputContract;
    if (callerContract) {
      const validation = validateCallerOutput(
        callerContract,
        input.panelOutputs[0]!.output,
      );
      if (!validation.ok) {
        const report = renderFailureReport({
          run: input.run,
          error: validation.error,
          panelOutputs: input.panelOutputs,
          failures: input.panelFailures,
          ...withJudgeModel(judgeModel),
          synthesis: resolveSynthesisMode(input.profile),
          panel: input.profile.panel,
        });
        return { kind: "fail", error: validation.error, report };
      }
    }

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
      runId: input.run.id,
      ...(input.run.outputContract
        ? { callerContract: input.run.outputContract }
        : {}),
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
