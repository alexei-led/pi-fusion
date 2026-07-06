import type { FailedPanelSummary, PanelOutput } from "./run-builder.js";
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
}

export type ExtractPanelResultsResult =
  | {
      ok: true;
      outputs: PanelOutput[];
      failures: FailedPanelSummary[];
      runId?: string;
    }
  | { ok: false; error: ResultExtractError };

interface ResultsContainer {
  payload: Record<string, unknown>;
  results: readonly unknown[];
  path: string;
}

type ChildStatus = "success" | "failed";

export function extractPanelResults(
  payload: unknown,
  options: ExtractPanelResultsOptions = {},
): ExtractPanelResultsResult {
  const container = findResultsContainer(payload);
  if (!container.ok) return container;

  const outputs: PanelOutput[] = [];
  const failures: FailedPanelSummary[] = [];
  for (const [index, rawResult] of container.results.entries()) {
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

  if (Array.isArray(payload.results)) {
    return { ok: true, payload, results: payload.results, path: "$.results" };
  }

  if ("results" in payload) {
    return error(
      "unknown-result-shape",
      "Subagents result payload results field must be an array.",
      "$.results",
    );
  }

  if (isRecord(payload.details)) {
    if (Array.isArray(payload.details.results)) {
      return {
        ok: true,
        payload: { ...payload, ...payload.details },
        results: payload.details.results,
        path: "$.details.results",
      };
    }
    if ("results" in payload.details) {
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
    const output =
      firstNonBlankString(
        rawResult.output,
        rawResult.finalOutput,
        rawResult.summary,
        rawResult.text,
      ) ?? artifactOutput(artifactPath);
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
        artifactPath,
        sessionPath,
      }),
    };
  }

  return {
    ok: true,
    status,
    failure: buildFailedPanelSummary({
      index,
      member,
      agent,
      summary: failureSummary(rawResult, artifactPath),
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
  artifactPath: string | undefined;
  sessionPath: string | undefined;
}): PanelOutput {
  return {
    index: input.index,
    agent: input.agent,
    output: input.output,
    ...(input.member?.id ? { id: input.member.id } : {}),
    ...(input.member?.label ? { label: input.member.label } : {}),
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
  };
}

function buildFailedPanelSummary(input: {
  index: number;
  member: PanelMemberConfig | undefined;
  agent: string;
  summary: string;
  artifactPath: string | undefined;
  sessionPath: string | undefined;
}): FailedPanelSummary {
  return {
    index: input.index,
    agent: input.agent,
    summary: input.summary,
    ...(input.member?.id ? { id: input.member.id } : {}),
    ...(input.member?.label ? { label: input.member.label } : {}),
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
  };
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
