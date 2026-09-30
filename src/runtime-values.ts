import { isRecord } from './utils.js';

// Node converts larger timeouts to 1ms rather than rejecting them.
export const MAX_TIMER_MS = 2 ** 31 - 1;

export function isTimerMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_TIMER_MS
  );
}

const WORKFLOW_FAILURE_KINDS = [
  'validation',
  'script',
  'child',
  'return-serialization',
  'timeout',
  'detached-child',
  'runtime',
] as const;
export type WorkflowFailureKind = (typeof WORKFLOW_FAILURE_KINDS)[number];

export function isWorkflowFailureKind(
  value: unknown,
): value is WorkflowFailureKind {
  return (
    typeof value === 'string' &&
    (WORKFLOW_FAILURE_KINDS as readonly string[]).includes(value)
  );
}

export function extractWorkflowFailureKind(
  payload: unknown,
): WorkflowFailureKind | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.data) ? payload.data : payload;
  const details = isRecord(data.details) ? data.details : data;
  const workflow = details.workflow;
  return isRecord(workflow) && isWorkflowFailureKind(workflow.failureKind)
    ? workflow.failureKind
    : undefined;
}
