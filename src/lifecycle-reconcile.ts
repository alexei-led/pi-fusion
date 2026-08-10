import type { FailedPanelSummary, PanelOutput } from "./types.js";
import { mergeRunObservations } from "./run-observations.js";
import {
  extractPanelResults,
  type ExtractPanelResultsResult,
  type ExtractPanelResultsSuccess,
} from "./result-extract.js";
import type { FusionProfile } from "./types.js";
import { isRecord } from "./utils.js";

export function reconcileIndexedLifecycleResult(
  eventPayload: unknown,
  statusPayload: unknown,
  index: number,
  label: "judge" | "panel",
): string | undefined {
  const eventResults = findLifecycleArray(eventPayload, "results");
  const eventResult = eventResults?.[index];
  if (!isRecord(eventResult)) return undefined;

  const statusSteps = findLifecycleArray(statusPayload, "steps");
  const rawStatusResults = findLifecycleArray(statusPayload, "results");
  const statusResults =
    statusSteps ?? (rawStatusResults?.length ? rawStatusResults : undefined);
  const statusResult = statusResults?.[index];
  if (statusResults && !isRecord(statusResult)) {
    return `Subagents event includes ${label} result ${index + 1}, but status does not.`;
  }
  if (!isRecord(statusResult)) return undefined;
  if (isFailedLifecycleResult(eventResult) === isFailedLifecycleResult(statusResult)) {
    return undefined;
  }
  return `Subagents event and status disagree about ${label} result ${index + 1}.`;
}

export interface ReconcilePanelResultsOptions {
  /** Extra terminal result allowed after the configured panel (the judge). */
  allowedTrailingResults?: number;
  /** Indices intentionally absent from status after early agreement. */
  stoppedPanelIndices?: readonly number[];
}

/**
 * Reconciles compact completion events with the richer lifecycle snapshot.
 * Status is authoritative when it describes every configured panel member.
 * Incomplete or contradictory lifecycle data fails closed.
 */
export function reconcilePanelResults(
  eventResults: ExtractPanelResultsSuccess,
  statusPayload: unknown,
  profile: FusionProfile,
  resultPayload: unknown,
  options: ReconcilePanelResultsOptions = {},
): ExtractPanelResultsResult {
  const expectedCount = profile.panel.length;
  const allowedTrailing = options.allowedTrailingResults ?? 0;
  const rawEvent = findLifecycleArray(resultPayload, "results");
  if (rawEvent && rawEvent.length > expectedCount + allowedTrailing) {
    return error(
      `Terminal subagents data contained ${rawEvent.length} results for ${expectedCount + allowedTrailing} expected workflow steps.`,
      "$.results",
    );
  }

  const rawStatusSteps = findLifecycleArray(statusPayload, "steps");
  const rawStatusResults = findLifecycleArray(statusPayload, "results");
  const rawStatus =
    rawStatusSteps ?? (rawStatusResults?.length ? rawStatusResults : undefined);
  if (!rawStatus) {
    if (eventResults.outputs.length + eventResults.failures.length !== expectedCount) {
      return error(
        `Terminal subagents data described ${eventResults.outputs.length + eventResults.failures.length} of ${expectedCount} configured panel members.`,
        "$.results",
      );
    }
    return eventResults;
  }

  if (rawStatus.length > expectedCount + allowedTrailing) {
    return error(
      `Terminal subagents status contained ${rawStatus.length} steps for ${expectedCount + allowedTrailing} expected workflow steps.`,
      "$.steps",
    );
  }

  const statusResults = extractPanelResults(statusPayload, {
    panel: profile.panel,
    completedOnly: true,
    limit: expectedCount,
    ...(options.stoppedPanelIndices
      ? { stoppedPanelIndices: options.stoppedPanelIndices }
      : {}),
  });
  if (!statusResults.ok) {
    return error(
      `${statusResults.error.message} (${statusResults.error.path})`,
      statusResults.error.path,
    );
  }

  const statusCount =
    statusResults.outputs.length + statusResults.failures.length;
  const eventCount =
    eventResults.outputs.length + eventResults.failures.length;
  const statusIndices = new Set([
    ...statusResults.outputs.map(({ index }) => index),
    ...statusResults.failures.map(({ index }) => index),
  ]);
  const stopped = new Set(options.stoppedPanelIndices ?? []);
  const missingStatusIndices = Array.from(
    { length: expectedCount },
    (_, index) => index,
  ).filter((index) => !statusIndices.has(index));

  if (statusCount === expectedCount) {
    return preserveAgreementReasons(statusResults, eventResults);
  }

  const missingWereStopped =
    eventCount === expectedCount &&
    missingStatusIndices.length > 0 &&
    missingStatusIndices.every((index) => stopped.has(index));
  if (!missingWereStopped) {
    return error(
      `Terminal subagents status described ${statusCount} of ${expectedCount} configured panel members.`,
      "$.steps",
    );
  }

  if (eventCount !== expectedCount) {
    return error(
      `Terminal subagents data described ${eventCount} of ${expectedCount} configured panel members.`,
      "$.results",
    );
  }

  return mergeObservations(eventResults, statusResults);
}

function preserveAgreementReasons(
  status: ExtractPanelResultsSuccess,
  event: ExtractPanelResultsSuccess,
): ExtractPanelResultsSuccess {
  const eventFailures = new Map(
    event.failures.map((failure) => [failure.index, failure]),
  );
  return {
    ...status,
    failures: status.failures.map((failure) => {
      const eventFailure = eventFailures.get(failure.index);
      return eventFailure?.reason === "stopped-after-agreement"
        ? { ...failure, reason: eventFailure.reason }
        : failure;
    }),
  };
}

function mergeObservations(
  event: ExtractPanelResultsSuccess,
  status: ExtractPanelResultsSuccess,
): ExtractPanelResultsSuccess {
  const observations = new Map<number, PanelOutput["observation"]>();
  for (const output of status.outputs) {
    observations.set(output.index, output.observation);
  }
  for (const failure of status.failures) {
    observations.set(failure.index, failure.observation);
  }

  return {
    ...event,
    outputs: event.outputs.map((output) =>
      withObservation(output, observations.get(output.index)),
    ),
    failures: event.failures.map((failure) =>
      withObservation(failure, observations.get(failure.index)),
    ),
  };
}

function withObservation<T extends PanelOutput | FailedPanelSummary>(
  item: T,
  statusObservation: PanelOutput["observation"] | undefined,
): T {
  const observation = mergeRunObservations(statusObservation, item.observation);
  return hasObservationData(observation) ? { ...item, observation } : item;
}

function hasObservationData(
  observation: PanelOutput["observation"] | undefined,
): boolean {
  return Boolean(
    observation &&
      (observation.model ||
        observation.durationMs !== undefined ||
        observation.usage ||
        observation.attempts ||
        observation.providerFailures),
  );
}

function findLifecycleArray(
  payload: unknown,
  key: "results" | "steps",
): readonly unknown[] | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = unknownArray(payload[key]);
  if (direct) return direct;
  if (isRecord(payload.details)) {
    const nested = unknownArray(payload.details[key]);
    if (nested) return nested;
  }
  if (isRecord(payload.data)) return findLifecycleArray(payload.data, key);
  return undefined;
}

function isFailedLifecycleResult(result: Record<string, unknown>): boolean {
  if (result.success === false) return true;
  if (result.timedOut === true || result.interrupted === true) return true;
  if (typeof result.error === "string" && result.error.trim()) return true;
  const status = firstString(result.status, result.state);
  return status === "failed" || status === "paused" || status === "detached";
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function unknownArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function error(
  message: string,
  path: string,
): ExtractPanelResultsResult {
  return {
    ok: false,
    error: {
      code: "unknown-result-shape",
      message,
      path,
    },
  };
}
