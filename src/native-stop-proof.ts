import { isRecord } from './utils.js';

export function ordinaryRetirementDetail(
  payload: unknown,
  runId: string,
): string {
  if (!isRecord(payload)) return 'native retirement proof unavailable';
  const lifecycle = isRecord(payload.lifecycleStatus)
    ? payload.lifecycleStatus
    : undefined;
  for (const proof of [
    payload.workflowTerminalProof,
    payload.processTerminal,
    lifecycle?.processTerminal,
  ]) {
    if (!isRecord(proof) || proof.version !== 1 || proof.runId !== runId)
      continue;
    const state = proof.state === 'pending' ? 'pending' : 'unknown';
    const reason =
      typeof proof.reason === 'string'
        ? proof.reason.slice(0, 500)
        : 'no verified tracked-run retirement';
    return `native retirement ${state}: ${reason}`;
  }
  const nested = payload.details ?? payload.data;
  return nested !== undefined
    ? ordinaryRetirementDetail(nested, runId)
    : 'native retirement proof unavailable';
}

/** Native tracked-run retirement only; never a kernel/escaped-descendant guarantee. */
export function ordinaryTerminalProof(
  payload: unknown,
  runId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const lifecycle = isRecord(payload.lifecycleStatus)
    ? payload.lifecycleStatus
    : undefined;
  for (const proof of [
    payload.workflowTerminalProof,
    payload.processTerminal,
    lifecycle?.processTerminal,
  ]) {
    if (
      !isRecord(proof) ||
      proof.version !== 1 ||
      proof.runId !== runId ||
      proof.state !== 'observed' ||
      typeof proof.observedAt !== 'number' ||
      !Number.isFinite(proof.observedAt)
    )
      continue;
    if (proof.kind === 'workflow') {
      if (
        proof.dispatchClosed === true &&
        Array.isArray(proof.children) &&
        proof.children.every(
          (child: unknown) =>
            isRecord(child) &&
            child.version === 1 &&
            typeof child.runId === 'string' &&
            typeof child.runnerProcessInstanceId === 'string' &&
            Boolean(child.runnerProcessInstanceId.trim()) &&
            (child.state === 'observed' || child.state === 'not-started'),
        )
      )
        return proof;
    } else if (
      typeof proof.runnerProcessInstanceId === 'string' &&
      proof.runnerProcessInstanceId.trim()
    )
      return proof;
  }
  return (
    ordinaryTerminalProof(payload.details, runId) ??
    ordinaryTerminalProof(payload.data, runId)
  );
}
