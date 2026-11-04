import { isRecord } from './utils.js';

function workflowValue(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.workflow) && payload.workflow.value !== undefined)
    return payload.workflow.value;
  return workflowValue(payload.details) ?? workflowValue(payload.data);
}

export function nativeJudgeValue(
  payload: unknown,
): Record<string, unknown> | undefined {
  const value = workflowValue(payload);
  return isRecord(value) &&
    value.key === 'judge' &&
    typeof value.ok === 'boolean'
    ? value
    : undefined;
}

export function nativePanelResults(
  payload: unknown,
): Record<string, unknown>[] | undefined {
  const value = workflowValue(payload);
  if (!Array.isArray(value) || !value.length) return undefined;
  const results: Record<string, unknown>[] = [];
  for (const child of value) {
    if (
      !isRecord(child) ||
      typeof child.key !== 'string' ||
      !/^panel-[1-9]\d*$/.test(child.key) ||
      typeof child.ok !== 'boolean'
    )
      return undefined;
    const raw = Array.isArray(child.results) ? child.results : [];
    if (raw.length > 1 || (raw.length === 1 && !isRecord(raw[0])))
      return undefined;
    const result = isRecord(raw[0]) ? raw[0] : {};
    results.push({
      ...result,
      workflowKey: child.key,
      agent: result.agent ?? child.agent,
      success: child.ok,
      output: result.finalOutput ?? result.output ?? child.output,
      ...(child.error !== undefined ? { error: child.error } : {}),
      ...(typeof child.outputArtifactPath === 'string'
        ? { artifactPath: child.outputArtifactPath }
        : {}),
    });
  }
  return results;
}
