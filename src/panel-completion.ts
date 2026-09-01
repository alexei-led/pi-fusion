import {
  detectCallerOutputContract,
  validateCallerOutput,
} from "./caller-contract.js";
import {
  renderFailureReport,
  renderPanelFailureReport,
  renderPartialPanelReport,
  renderSinglePanelReport,
} from "./report.js";
import {
  appendThinkingSuffix,
  buildJudgeSpawnParams,
  type JudgeSpawnParams,
} from "./run-builder.js";
import { resolveMinimumSuccessfulPanelists } from "./panel-quorum.js";
import {
  resolveSynthesisMode,
  type FailedPanelSummary,
  type FusionProfile,
  type FusionRun,
  type PanelOutput,
} from "./types.js";

export { resolveMinimumSuccessfulPanelists } from "./panel-quorum.js";

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
  const synthesis = resolveSynthesisMode(input.profile);
  const required = resolveMinimumSuccessfulPanelists(
    input.run.minimumSuccessfulPanelists ??
      input.profile.minimumSuccessfulPanelists,
    input.profile.panel.length,
  );
  // A configured one-member panel is still validated as an exact caller
  // contract, but does not need a synthetic comparison.
  if (
    synthesis !== "merge" &&
    input.profile.panel.length === 1 &&
    input.panelOutputs.length === 1
  ) {
    const callerContract =
      input.run.outputContract ??
      detectCallerOutputContract(input.run.prompt);
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
          synthesis,
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

  // Synthesis needs two candidates for select mode. A lower configured quorum
  // still produces a useful, explicitly unsynthesized partial report instead
  // of pretending that one panelist is a panel.
  if (
    (input.panelOutputs.length < required && !intentionalStops) ||
    input.panelOutputs.length < 2
  ) {
    const report = renderPartialPanelReport({
      run: { ...input.run, completionQuality: "partial" },
      panelOutputs: input.panelOutputs,
      failures: input.panelFailures,
      required,
      synthesis,
      panel: input.profile.panel,
      ...withJudgeModel(judgeModel),
    });
    const callerContract =
      input.run.outputContract ?? detectCallerOutputContract(input.run.prompt);
    if (callerContract) {
      // A partial report must disclose its incomplete coverage, but that prose
      // is forbidden by exact caller contracts. Do not publish a report that
      // merely looks successful while violating the caller's protocol.
      const validation = validateCallerOutput(callerContract, report);
      if (!validation.ok) {
        const error = `${validation.error} Fusion could not synthesize a contract-compliant result from below-quorum panel coverage.`;
        return {
          kind: "fail",
          error,
          report: renderFailureReport({
            run: input.run,
            error,
            panelOutputs: input.panelOutputs,
            failures: input.panelFailures,
            ...withJudgeModel(judgeModel),
            synthesis,
            panel: input.profile.panel,
          }),
        };
      }
    }
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
      ...(input.run.timeoutOverrides
        ? { timeoutOverrides: input.run.timeoutOverrides }
        : {}),
      ...(input.run.effectiveTimeouts
        ? { effectiveTimeouts: input.run.effectiveTimeouts }
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
