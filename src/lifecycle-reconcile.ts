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
  const statusResults = authoritativeStatusLifecycleArray(
    statusPayload,
    statusSteps,
    rawStatusResults,
  );
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
  /** A workflow deadline terminalized running child slots as timeout failures. */
  terminalizeRunning?: boolean;
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
  // Preserve an explicit terminal `results: []`: it is authoritative even
  // when it contains no child results. A running empty poll, however, is not
  // a terminal lifecycle assertion and can race a completion event.
  const rawStatus = authoritativeStatusLifecycleArray(
    statusPayload,
    rawStatusSteps,
    rawStatusResults,
  );
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
    ...(options.terminalizeRunning
      ? { terminalizeRunning: true }
      : { completedOnly: true }),
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
  if (
    !options.terminalizeRunning &&
    eventResults.outputs.length + eventResults.failures.length === expectedCount
  ) {
    const eventSucceeded = new Set(eventResults.outputs.map((item) => item.index));
    const statusSucceeded = new Set(statusResults.outputs.map((item) => item.index));
    for (let index = 0; index < expectedCount; index++) {
      const eventKnown =
        eventSucceeded.has(index) || eventResults.failures.some((item) => item.index === index);
      const statusKnown =
        statusSucceeded.has(index) || statusResults.failures.some((item) => item.index === index);
      if (eventKnown && statusKnown && eventSucceeded.has(index) !== statusSucceeded.has(index)) {
        return error(
          `Subagents event and status disagree about panel result ${index + 1}.`,
          `$.steps[${index}]`,
        );
      }
    }
  }
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
    return options.terminalizeRunning
      ? mergeTerminalDeadlineResults(
          eventResults,
          statusResults,
          statusPayload,
          resultPayload,
        )
      : preserveAgreementReasons(statusResults, eventResults);
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

/**
 * Status is normally authoritative. At a workflow deadline it can still show
 * a child as running even though the completion artifact contains that child's
 * verified final output. Keep that verified output, normalize only genuinely
 * unfinished slots, and retain status observations/failure details.
 */
function mergeTerminalDeadlineResults(
  event: ExtractPanelResultsSuccess,
  status: ExtractPanelResultsSuccess,
  statusPayload: unknown,
  eventPayload: unknown,
): ExtractPanelResultsSuccess {
  const eventOutputs = new Map(event.outputs.map((item) => [item.index, item]));
  const eventFailures = new Map(event.failures.map((item) => [item.index, item]));
  const statusOutputs = new Map(status.outputs.map((item) => [item.index, item]));
  const statusFailures = new Map(status.failures.map((item) => [item.index, item]));
  const replaceableSlots = deadlineEventReplacementSlots(
    statusPayload,
    eventPayload,
  );
  const outputs: PanelOutput[] = [];
  const failures: FailedPanelSummary[] = [];
  const maxIndex = Math.max(
    ...[...eventOutputs.keys(), ...eventFailures.keys(), ...statusOutputs.keys(), ...statusFailures.keys()],
    -1,
  );
  for (let index = 0; index <= maxIndex; index++) {
    const eventOutput = eventOutputs.get(index);
    const eventFailure = eventFailures.get(index);
    const statusOutput = statusOutputs.get(index);
    const statusFailure = statusFailures.get(index);

    // A completed status slot is authoritative even when a stale compact
    // event reports a failure. Event data can replace only a status slot that
    // deadline handling normalized from a nonterminal state, and only when
    // both records identify the same public panel-N slot.
    if (!replaceableSlots.has(index)) {
      if (statusOutput) outputs.push(statusOutput);
      else if (statusFailure) failures.push(statusFailure);
      continue;
    }

    if (eventOutput) {
      outputs.push(withObservation(eventOutput, statusFailure?.observation));
    } else if (eventFailure) {
      failures.push(withObservation(eventFailure, statusFailure?.observation));
    } else if (statusFailure) {
      failures.push(statusFailure);
    }
  }
  return { ok: true, outputs, failures, ...(event.runId ? { runId: event.runId } : {}) };
}

/**
 * Deadline reconciliation never trusts compact-event array order: failed
 * children can be omitted or arrive late. A compact event may replace only a
 * status record terminalized from a nonterminal state when both explicitly
 * name the same public workflow slot.
 */
function deadlineEventReplacementSlots(
  statusPayload: unknown,
  eventPayload: unknown,
): ReadonlySet<number> {
  const statusResults =
    findLifecycleArray(statusPayload, "steps") ??
    findLifecycleArray(statusPayload, "results");
  const eventResults = findLifecycleArray(eventPayload, "results");
  if (!statusResults || !eventResults) return new Set<number>();

  const nonterminalStatusSlots = new Set<number>();
  for (const result of statusResults) {
    const slot = stablePanelSlot(result);
    if (slot !== undefined && isNonterminalLifecycleResult(result)) {
      nonterminalStatusSlots.add(slot);
    }
  }

  const matchingEventSlots = new Set<number>();
  for (const result of eventResults) {
    const slot = stablePanelSlot(result);
    if (slot !== undefined && nonterminalStatusSlots.has(slot)) {
      matchingEventSlots.add(slot);
    }
  }
  return matchingEventSlots;
}

function stablePanelSlot(result: unknown): number | undefined {
  if (!isRecord(result)) return undefined;
  // Result extraction already accepts these lifecycle fields as zero-based
  // public slots. Keep deadline matching exactly aligned; a numeric 1 must
  // mean panel slot 1, never a guessed one-based panel-1.
  for (const candidate of [result.index, result.taskIndex, result.stepIndex]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  const key = firstString(
    result.key,
    result.taskKey,
    result.stepKey,
    result.agent,
  );
  const match = key?.match(/^panel-([1-9]\d*)$/);
  return match ? Number(match[1]) - 1 : undefined;
}

function isNonterminalLifecycleResult(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const status = firstString(result.status, result.state);
  return (
    status === "running" ||
    status === "active" ||
    status === "pending" ||
    status === "queued"
  );
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

function authoritativeStatusLifecycleArray(
  payload: unknown,
  steps: readonly unknown[] | undefined,
  results: readonly unknown[] | undefined,
): readonly unknown[] | undefined {
  const lifecycle = steps ?? results;
  if (!lifecycle || lifecycle.length > 0 || isTerminalLifecyclePayload(payload)) {
    return lifecycle;
  }
  return undefined;
}

function isTerminalLifecyclePayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const state = firstString(payload.state, payload.status);
  const textState = firstString(payload.text)?.match(
    /(?:^|\n)(?:State|Status):\s*([^\n\r]+)/i,
  )?.[1]?.trim();
  if (
    state === "complete" ||
    textState === "complete" ||
    textState === "completed" ||
    textState === "done" ||
    textState === "failed" ||
    textState === "paused" ||
    textState === "detached" ||
    state === "completed" ||
    state === "done" ||
    state === "failed" ||
    state === "paused" ||
    state === "detached"
  ) {
    return true;
  }
  if (isRecord(payload.details) && isTerminalLifecyclePayload(payload.details)) {
    return true;
  }
  return isRecord(payload.data) && isTerminalLifecyclePayload(payload.data);
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
