import type {
  ModelAttempt,
  PanelConfidence,
  PanelDecision,
  PanelOutput,
  ProviderFailure,
  RunObservation,
  RunUsage,
} from "./types.js";
import { isFiniteNumber, isRecord } from "./utils.js";

export const PANEL_DECISION_OPEN = "<fusion-panel-decision>";
export const PANEL_DECISION_CLOSE = "</fusion-panel-decision>";

export function extractPanelDecision(
  value: unknown,
): PanelDecision | undefined {
  if (typeof value === "string") return extractTaggedPanelDecision(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return extractTaggedPanelDecision(value.join("\n"));
  }
  return isRecord(value) ? panelDecisionFromRecord(value) : undefined;
}

function extractTaggedPanelDecision(value: string): PanelDecision | undefined {
  const openIndex = value.lastIndexOf(PANEL_DECISION_OPEN);
  if (openIndex < 0) return undefined;
  const jsonStart = openIndex + PANEL_DECISION_OPEN.length;
  const closeIndex = value.indexOf(PANEL_DECISION_CLOSE, jsonStart);
  if (closeIndex < 0) return undefined;
  const closeEnd = closeIndex + PANEL_DECISION_CLOSE.length;
  if (value.slice(closeEnd).trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(jsonStart, closeIndex));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const answerMarkdown = value.slice(0, openIndex).trim();
  return panelDecisionFromRecord(parsed, answerMarkdown);
}

function panelDecisionFromRecord(
  value: Record<string, unknown>,
  fallbackAnswerMarkdown?: string,
): PanelDecision | undefined {
  const recommendation = firstNonBlankString(value.recommendation);
  const answerMarkdown =
    firstNonBlankString(value.answerMarkdown) ?? fallbackAnswerMarkdown;
  const confidence = value.confidence;
  if (
    !recommendation ||
    !answerMarkdown ||
    !isPanelConfidence(confidence) ||
    typeof value.needsMoreEvidence !== "boolean"
  ) {
    return undefined;
  }
  return {
    recommendation,
    confidence,
    needsMoreEvidence: value.needsMoreEvidence,
    answerMarkdown,
  };
}

export function normalizeRecommendation(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function hasStrongPanelAgreement(
  outputs: readonly PanelOutput[],
  completedPanelCount: number,
  totalPanelCount: number,
): boolean {
  if (outputs.length < 2 || completedPanelCount >= totalPanelCount) {
    return false;
  }
  const decisions = outputs.map((output) => output.decision);
  if (decisions.some((decision) => !decision)) return false;
  if (
    decisions.some(
      (decision) =>
        decision?.confidence !== "high" || decision.needsMoreEvidence,
    )
  ) {
    return false;
  }
  const recommendation = normalizeRecommendation(
    decisions[0]?.recommendation ?? "",
  );
  return Boolean(
    recommendation &&
    decisions.every(
      (decision) =>
        decision &&
        normalizeRecommendation(decision.recommendation) === recommendation,
    ),
  );
}

export function mergeRunObservations(
  base: RunObservation | undefined,
  latest: RunObservation | undefined,
): RunObservation {
  if (!base) return latest ? cloneObservation(latest) : {};
  if (!latest) return cloneObservation(base);
  const failures = summarizeProviderFailures([
    ...(base.providerFailures ?? []),
    ...(latest.providerFailures ?? []),
  ]).map(({ count, ...failure }) =>
    count && count > 1 ? { ...failure, count } : failure,
  );
  return {
    ...((latest.model ?? base.model)
      ? { model: latest.model ?? base.model }
      : {}),
    ...((latest.durationMs ?? base.durationMs) !== undefined
      ? { durationMs: latest.durationMs ?? base.durationMs }
      : {}),
    ...mergeUsage(base.usage, latest.usage),
    ...((latest.attempts ?? base.attempts)
      ? {
          attempts: [...(latest.attempts ?? base.attempts ?? [])].map(
            (attempt) => ({ ...attempt }),
          ),
        }
      : {}),
    ...(failures.length > 0 ? { providerFailures: failures } : {}),
  };
}

export function extractRunObservation(value: unknown): RunObservation {
  if (!isRecord(value)) return {};

  const model = firstString(value.model);
  const durationMs = extractDuration(value);
  const usage = extractUsage(value);
  const attempts = extractAttempts(value.modelAttempts);
  const attemptFailures = attempts.flatMap((attempt) =>
    attempt.success || !attempt.error
      ? []
      : [providerFailureFromAttempt(attempt)],
  );
  const rawError = firstNonBlankString(value.error);
  const providerFailures = summarizeProviderFailures(
    rawError &&
      attemptFailures.length === 0 &&
      (value.success === false || value.state === "failed")
      ? [
          {
            provider: model ? providerFromModel(model) : "unknown provider",
            ...(model ? { model } : {}),
            message: rawError,
          },
        ]
      : attemptFailures,
  ).map(({ count, ...failure }) =>
    count && count > 1 ? { ...failure, count } : failure,
  );

  return {
    ...(model ? { model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(usage ? { usage } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(providerFailures.length > 0 ? { providerFailures } : {}),
  };
}

export function summarizeProviderFailures(
  failures: readonly ProviderFailure[],
): ProviderFailure[] {
  const grouped = new Map<string, ProviderFailure & { count: number }>();
  for (const failure of failures) {
    const message = failure.message.trim();
    if (!message) continue;
    const key = `${failure.provider}\u0000${failure.model ?? ""}\u0000${message}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += failure.count ?? 1;
      continue;
    }
    grouped.set(key, {
      ...failure,
      message,
      count: failure.count ?? 1,
    });
  }

  return [...grouped.values()]
    .sort((left, right) =>
      `${left.provider}\u0000${left.model ?? ""}\u0000${left.message}`.localeCompare(
        `${right.provider}\u0000${right.model ?? ""}\u0000${right.message}`,
      ),
    )
    .map(({ count, ...failure }) => ({ ...failure, count }));
}

function mergeUsage(
  base: RunUsage | undefined,
  latest: RunUsage | undefined,
): { usage?: RunUsage } {
  if (!base && !latest) return {};
  const inputTokens = latest?.inputTokens ?? base?.inputTokens;
  const outputTokens = latest?.outputTokens ?? base?.outputTokens;
  const costUsd = latest?.costUsd ?? base?.costUsd;
  const usage: RunUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return { usage };
}

function cloneObservation(observation: RunObservation): RunObservation {
  return {
    ...observation,
    ...(observation.usage ? { usage: { ...observation.usage } } : {}),
    ...(observation.attempts
      ? { attempts: observation.attempts.map((attempt) => ({ ...attempt })) }
      : {}),
    ...(observation.providerFailures
      ? {
          providerFailures: observation.providerFailures.map((failure) => ({
            ...failure,
          })),
        }
      : {}),
  };
}

function extractDuration(value: Record<string, unknown>): number | undefined {
  if (isFiniteNumber(value.durationMs) && value.durationMs >= 0) {
    return value.durationMs;
  }
  if (
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.endedAt) &&
    value.endedAt >= value.startedAt
  ) {
    return value.endedAt - value.startedAt;
  }
  return undefined;
}

function extractUsage(value: Record<string, unknown>): RunUsage | undefined {
  const totalCost = isRecord(value.totalCost) ? value.totalCost : undefined;
  const rawUsage = isRecord(value.usage) ? value.usage : undefined;
  const inputTokens = firstFinite(
    totalCost?.inputTokens,
    rawUsage?.inputTokens,
    rawUsage?.input,
  );
  const outputTokens = firstFinite(
    totalCost?.outputTokens,
    rawUsage?.outputTokens,
    rawUsage?.output,
  );
  const costUsd = firstFinite(
    totalCost?.costUsd,
    rawUsage?.costUsd,
    isRecord(rawUsage?.cost) ? rawUsage.cost.total : undefined,
  );

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function extractAttempts(value: unknown): ModelAttempt[] {
  if (!Array.isArray(value)) return [];
  const attempts: ModelAttempt[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const model = firstString(item.model);
    if (!model || typeof item.success !== "boolean") continue;
    const error = firstString(item.error);
    attempts.push({
      model,
      success: item.success,
      ...(error ? { error } : {}),
    });
  }
  return attempts;
}

function providerFailureFromAttempt(attempt: ModelAttempt): ProviderFailure {
  return {
    provider: providerFromModel(attempt.model),
    model: attempt.model,
    message: attempt.error ?? "model attempt failed",
  };
}

function providerFromModel(model: string): string {
  return model.split("/", 1)[0] || "unknown provider";
}

function firstFinite(...values: readonly unknown[]): number | undefined {
  return values.find(isFiniteNumber);
}

function isPanelConfidence(value: unknown): value is PanelConfidence {
  return value === "low" || value === "medium" || value === "high";
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

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}
