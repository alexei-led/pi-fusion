import {
  appendThinkingSuffix,
  type FailedPanelSummary,
  type PanelOutput,
} from "./run-builder.js";
import {
  extractPanelDecision,
  extractRunObservation,
} from "./run-observations.js";
import type { PanelMemberConfig } from "./types.js";

export type ResultExtractErrorCode =
  "missing-results" | "unknown-result-shape" | "missing-result-field";

export interface ResultExtractError {
  code: ResultExtractErrorCode;
  message: string;
  path: string;
}

export interface ExtractPanelResultsOptions {
  panel?: readonly PanelMemberConfig[];
  limit?: number;
  completedOnly?: boolean;
  stoppedPanelIndices?: readonly number[];
}

export type ExtractPanelResultsSuccess = {
  ok: true;
  outputs: PanelOutput[];
  failures: FailedPanelSummary[];
  runId?: string;
};

export type ExtractPanelResultsResult =
  ExtractPanelResultsSuccess | { ok: false; error: ResultExtractError };

interface ResultsContainer {
  payload: Record<string, unknown>;
  results: readonly unknown[];
  path: string;
}

type ChildStatus = "success" | "failed";

function isCompletedResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const status = firstString(value.status, value.state);
  return !(
    status === "running" ||
    status === "active" ||
    status === "pending" ||
    status === "queued"
  );
}

export function extractPanelResults(
  payload: unknown,
  options: ExtractPanelResultsOptions = {},
): ExtractPanelResultsResult {
  const container = findResultsContainer(payload);
  if (!container.ok) return container;

  const outputs: PanelOutput[] = [];
  const failures: FailedPanelSummary[] = [];
  const results =
    options.limit === undefined
      ? container.results
      : container.results.slice(0, options.limit);
  for (const [index, rawResult] of results.entries()) {
    if (options.completedOnly && !isCompletedResult(rawResult)) continue;
    const child = normalizeChildResult(rawResult, index, options);
    if (!child.ok) return child;
    if (child.status === "success") outputs.push(child.output);
    else failures.push(child.failure);
  }

  const runId = firstString(container.payload.runId, container.payload.id);
  return {
    ok: true,
    outputs,
    failures,
    ...(runId ? { runId } : {}),
  };
}

function findResultsContainer(
  payload: unknown,
):
  | (ExtractPanelResultsResult & { ok: false })
  | ({ ok: true } & ResultsContainer) {
  if (!isRecord(payload)) {
    return error(
      "unknown-result-shape",
      "Subagents result payload must be an object.",
      "$",
    );
  }

  if (Array.isArray(payload.results) && payload.results.length > 0) {
    return { ok: true, payload, results: payload.results, path: "$.results" };
  }

  if (Array.isArray(payload.steps)) {
    return { ok: true, payload, results: payload.steps, path: "$.steps" };
  }

  if (Array.isArray(payload.results)) {
    return { ok: true, payload, results: payload.results, path: "$.results" };
  }

  if ("results" in payload && !Array.isArray(payload.results)) {
    return error(
      "unknown-result-shape",
      "Subagents result payload results field must be an array.",
      "$.results",
    );
  }

  if (isRecord(payload.details)) {
    if (
      Array.isArray(payload.details.results) &&
      payload.details.results.length > 0
    ) {
      return {
        ok: true,
        payload: { ...payload, ...payload.details },
        results: payload.details.results,
        path: "$.details.results",
      };
    }
    if (Array.isArray(payload.details.steps)) {
      return {
        ok: true,
        payload: { ...payload, ...payload.details },
        results: payload.details.steps,
        path: "$.details.steps",
      };
    }
    if (Array.isArray(payload.details.results)) {
      return {
        ok: true,
        payload: { ...payload, ...payload.details },
        results: payload.details.results,
        path: "$.details.results",
      };
    }
    if (
      "results" in payload.details &&
      !Array.isArray(payload.details.results)
    ) {
      return error(
        "unknown-result-shape",
        "Subagents result details.results field must be an array.",
        "$.details.results",
      );
    }
  }

  if (isRecord(payload.data)) return findResultsContainer(payload.data);

  return error(
    "missing-results",
    "Subagents result payload did not include a results array.",
    "$",
  );
}

function normalizeChildResult(
  rawResult: unknown,
  index: number,
  options: ExtractPanelResultsOptions,
):
  | { ok: true; status: "success"; output: PanelOutput }
  | { ok: true; status: "failed"; failure: FailedPanelSummary }
  | { ok: false; error: ResultExtractError } {
  const path = `$.results[${index}]`;
  if (!isRecord(rawResult)) {
    return error(
      "unknown-result-shape",
      "Subagents child result must be an object.",
      path,
    );
  }

  const member = options.panel?.[index];
  const agent = firstString(rawResult.agent, member?.agent);
  if (!agent) {
    return error(
      "missing-result-field",
      "Subagents child result did not include an agent.",
      `${path}.agent`,
    );
  }

  const artifactPath = extractArtifactPath(rawResult);
  const sessionPath = firstString(rawResult.sessionPath, rawResult.sessionFile);
  const status = classifyChildStatus(rawResult);

  if (status === "success") {
    const rawOutput = firstNonBlankString(
      rawResult.output,
      rawResult.finalOutput,
      rawResult.summary,
      rawResult.text,
      recentOutputText(rawResult.recentOutput),
    );
    const decision =
      extractPanelDecision(rawResult.structuredOutput) ??
      extractPanelDecision(rawOutput);
    const output =
      firstNonBlankString(decision?.answerMarkdown, rawOutput) ??
      artifactOutput(artifactPath);
    if (!output) {
      return error(
        "missing-result-field",
        "Successful subagents child result did not include output or an artifact path.",
        path,
      );
    }
    return {
      ok: true,
      status,
      output: buildPanelOutput({
        index,
        member,
        agent,
        output,
        decision,
        observation: extractRunObservation(rawResult),
        artifactPath,
        sessionPath,
      }),
    };
  }

  const stoppedAfterAgreement =
    options.stoppedPanelIndices?.includes(index) === true;
  const observation = extractRunObservation(rawResult);
  if (stoppedAfterAgreement) delete observation.providerFailures;
  return {
    ok: true,
    status,
    failure: buildFailedPanelSummary({
      index,
      member,
      agent,
      summary: stoppedAfterAgreement
        ? "Stopped after strong panel agreement."
        : failureSummary(rawResult, artifactPath),
      reason: failureReason(rawResult, stoppedAfterAgreement),
      observation,
      artifactPath,
      sessionPath,
    }),
  };
}

function classifyChildStatus(result: Record<string, unknown>): ChildStatus {
  if (result.success === true) return "success";
  if (result.success === false) return "failed";
  if (result.timedOut === true || result.interrupted === true) return "failed";
  if (firstNonBlankString(result.error)) return "failed";

  const status = firstString(result.status, result.state);
  if (status) {
    if (status === "completed" || status === "complete") return "success";
    if (status === "failed" || status === "paused" || status === "detached") {
      return "failed";
    }
  }

  if (typeof result.exitCode === "number") {
    return result.exitCode === 0 ? "success" : "failed";
  }

  return firstNonBlankString(result.output, result.finalOutput, result.summary)
    ? "success"
    : "failed";
}

function failureSummary(
  result: Record<string, unknown>,
  artifactPath: string | undefined,
): string {
  const errorText = firstNonBlankString(result.error);
  const outputText = firstNonBlankString(
    result.summary,
    result.output,
    result.finalOutput,
    result.text,
  );
  if (errorText && outputText && errorText !== outputText) {
    return `${errorText}\n\n${outputText}`;
  }
  if (errorText) return errorText;
  if (outputText) return outputText;
  return artifactOutput(artifactPath) ?? "Panelist failed without a summary.";
}

function buildPanelOutput(input: {
  index: number;
  member: PanelMemberConfig | undefined;
  agent: string;
  output: string;
  decision: PanelOutput["decision"];
  observation: PanelOutput["observation"];
  artifactPath: string | undefined;
  sessionPath: string | undefined;
}): PanelOutput {
  const model =
    input.observation?.model ??
    (input.member
      ? appendThinkingSuffix(input.member.model, input.member.thinking)
      : undefined);
  const output: PanelOutput = {
    index: input.index,
    agent: input.agent,
    output: input.output,
    ...(input.member?.id ? { id: input.member.id } : {}),
    ...(input.member?.label ? { label: input.member.label } : {}),
    ...(input.member?.role ? { role: input.member.role } : {}),
    ...(model ? { model } : {}),
    ...(input.decision ? { decision: input.decision } : {}),
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
  };
  if (hasObservation(input.observation)) {
    output.observation = input.observation;
  }
  return output;
}

function buildFailedPanelSummary(input: {
  index: number;
  member: PanelMemberConfig | undefined;
  agent: string;
  summary: string;
  reason: FailedPanelSummary["reason"];
  observation: FailedPanelSummary["observation"];
  artifactPath: string | undefined;
  sessionPath: string | undefined;
}): FailedPanelSummary {
  const model =
    input.observation?.model ??
    (input.member
      ? appendThinkingSuffix(input.member.model, input.member.thinking)
      : undefined);
  const failure: FailedPanelSummary = {
    index: input.index,
    agent: input.agent,
    summary: input.summary,
    ...(input.member?.id ? { id: input.member.id } : {}),
    ...(input.member?.label ? { label: input.member.label } : {}),
    ...(input.member?.role ? { role: input.member.role } : {}),
    ...(model ? { model } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
  };
  if (hasObservation(input.observation)) {
    failure.observation = input.observation;
  }
  return failure;
}

function failureReason(
  result: Record<string, unknown>,
  stoppedAfterAgreement = false,
): FailedPanelSummary["reason"] {
  if (stoppedAfterAgreement) return "stopped-after-agreement";
  if (result.timedOut === true) return "timeout";
  if (result.interrupted === true) return "interrupted";
  return undefined;
}

function hasObservation(
  observation: PanelOutput["observation"] | undefined,
): observation is NonNullable<PanelOutput["observation"]> {
  return Boolean(
    observation &&
    (observation.model ||
      observation.durationMs !== undefined ||
      observation.usage ||
      observation.attempts ||
      observation.providerFailures),
  );
}

function extractArtifactPath(
  result: Record<string, unknown>,
): string | undefined {
  const direct = firstString(result.artifactPath, result.savedOutputPath);
  if (direct) return direct;
  if (isRecord(result.artifactPaths)) {
    return firstString(result.artifactPaths.outputPath);
  }
  if (isRecord(result.outputReference)) {
    return firstString(result.outputReference.path);
  }
  return undefined;
}

function artifactOutput(path: string | undefined): string | undefined {
  return path ? `Output artifact: ${path}` : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function recentOutputText(value: unknown): string | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return value.join("\n").trim() || undefined;
}

function firstNonBlankString(
  ...values: readonly unknown[]
): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function error(
  code: ResultExtractErrorCode,
  message: string,
  path: string,
): { ok: false; error: ResultExtractError } {
  return { ok: false, error: { code, message, path } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
